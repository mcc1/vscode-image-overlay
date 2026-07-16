import exifr from 'exifr';
import {
  fmtSize, fmtExposure, formatMaybeDate, getExt, gcdRatio,
  escapeHtml, escapeAttr,
  isTiffName, isHeicName,
  pick,
  formatExifColorSpace,
  describeColorSpace, detectHdr, describeColorMode, describeCaptureExtras,
  mapUrl, computeMapView,
} from './lib/format.js';
import { enrichFromBytes } from './lib/format-enrich.js';

interface SiblingItem {
  uri: string;
  name: string;
  size: number;
  mtime: number;
  ctime: number;
}

interface InjectedCtx {
  filename: string;
  fileSize: number;
  mtime: number;
  imageUri: string;
  defaultVisible: boolean;
  autoContrast: boolean;
  showHint: boolean;
  gpsMapProvider: 'openstreetmap' | 'google' | 'apple' | 'none';
  siblings: SiblingItem[];
  currentIndex: number;
  browseLoop: boolean;
  slideshowIntervalMs: number;
  histogramOn: boolean;
  heicWorkerUri: string;
  tiffWorkerUri: string;
}

const ctx = (window as unknown as { __IMG_CTX__: InjectedCtx }).__IMG_CTX__;

// Webview → host channel (used to keep session-scoped UI flags like the
// histogram toggle in sync across separate webviews of the same provider).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();
// Announce we're live so the host can deliver the sibling list. The provider
// no longer inlines siblings into the HTML — it enumerates the folder
// asynchronously and posts { type: 'siblings', ... } back (at most once).
// Sent here, before any image wiring, so the host never races the webview.
// ctx therefore arrives with siblings: [] and currentIndex: 0.
vscodeApi.postMessage({ type: 'ready' });

const img = document.getElementById('img') as HTMLImageElement;
// Zoom/pan transforms live on the wrapper, not on the <img> itself —
// keeping <img> off the transform tree dodges Chromium's GPU-compositor
// tile-seam bug that draws 1px black lines across large scaled images.
// See media/viewer.css for the matching #img-wrap rules.
const imgWrap = document.getElementById('img-wrap') as HTMLDivElement;
// Canvas presentation surface for decoder formats (TIFF/HEIC). The provider
// HTML is frozen (it only ships the <img>), so the canvas is created here and
// parked alongside <img> inside #img-wrap. Exactly one of the two is visible
// at a time — applyTransform() sizes/shows the active element and display:none
// hides the other. TIFF/HEIC decode straight onto this canvas via ImageBitmap,
// skipping the old RGBA → PNG-encode → <img> re-decode round-trip.
const canvas = document.createElement('canvas');
canvas.id = 'canvas';
canvas.draggable = false;
canvas.style.display = 'none';
imgWrap.appendChild(canvas);
const stage = document.getElementById('stage') as HTMLDivElement;
const hint = document.getElementById('hint') as HTMLDivElement;

type CornerKey = 'tl' | 'tr' | 'bl' | 'br';
const overlays: Record<CornerKey, HTMLElement> = {
  tl: document.getElementById('overlay-tl')!,
  tr: document.getElementById('overlay-tr')!,
  bl: document.getElementById('overlay-bl')!,
  br: document.getElementById('overlay-br')!,
};

const state = {
  visible: ctx.defaultVisible,
  expanded: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  exif: null as Record<string, unknown> | null,
  natural: { w: 0, h: 0 },
  currentUri: ctx.imageUri,
  filename: ctx.filename,
  fileSize: ctx.fileSize,
  mtime: ctx.mtime,
  hasAlpha: null as boolean | null,
  // Browse/slideshow — siblings come from the host already sorted+filtered.
  currentIndex: ctx.currentIndex,
  slideshowOn: false,
  slideshowIntervalMs: ctx.slideshowIntervalMs,
  // Generation token for image swaps. Each navigate() bumps this; pending
  // image-load handlers compare against it and bail if superseded. Without
  // this, fast ←/→ presses can race and call settleImage() out of order.
  loadGen: 0,
  // Which surface is live: the native <img> or the decode <canvas>. TIFF/HEIC
  // present on the canvas; everything else on the <img>. activeEl() reads this
  // so the sampler, histogram and applyTransform all target the right element.
  presenting: 'img' as 'img' | 'canvas',
};

// The element currently showing pixels. Consumers that read the decoded image
// (corner luminance sampler, histogram, transform sizing) go through this so
// they work identically whether the source is a native <img> or a decoded
// <canvas>.
function activeEl(): HTMLImageElement | HTMLCanvasElement {
  return state.presenting === 'canvas' ? canvas : img;
}

// Slideshow tuning bounds.
const SLIDESHOW_MIN_MS = 500;
const SLIDESHOW_MAX_MS = 30000;

// Histogram — opt-in (H to toggle). State is session-scoped to the
// extension-host process, NOT to the individual webview, so opening a
// different image from Explorer keeps the histogram on. Initial value
// arrives via ctx.histogramOn; toggle changes are pushed back to the host.
interface HistData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  a: Uint32Array;
  hasAlpha: boolean;
}
const histState = {
  on: !!ctx.histogramOn,
  computed: null as HistData | null,
  // Generation token: each compute bumps this. Async chunks / worker
  // callbacks check before committing results, so a toggle-off or image-swap
  // mid-scan doesn't get its stale histogram painted.
  gen: 0,
};

// Worker source — kept inline as a string so we don't need an extra esbuild
// entrypoint. It's tiny and only runs once per scan. Loaded via Blob URL,
// permitted by `worker-src blob:` in the CSP.
//
// Accepts either:
//   { bitmap, width, height }   — preferred. Uses OffscreenCanvas to
//                                 decode + read pixels off-thread, so the
//                                 main thread never sees drawImage /
//                                 getImageData on a natural-size canvas.
//   { buffer, length }          — fallback when the host can't construct
//                                 an ImageBitmap (then the main thread had
//                                 to read pixels itself).
const HISTOGRAM_WORKER_SRC = `
self.onmessage = function(e) {
  try {
    var msg = e.data;
    var data, len;
    if (msg.bitmap) {
      var w = msg.width, h = msg.height;
      var off = new OffscreenCanvas(w, h);
      var ctx = off.getContext('2d');
      ctx.drawImage(msg.bitmap, 0, 0);
      msg.bitmap.close();
      data = ctx.getImageData(0, 0, w, h).data;
      len = data.length;
    } else {
      data = new Uint8ClampedArray(msg.buffer);
      len = msg.length || data.length;
    }
    var r = new Uint32Array(256);
    var g = new Uint32Array(256);
    var b = new Uint32Array(256);
    var a = new Uint32Array(256);
    var alpha = false;
    for (var i = 0; i < len; i += 4) {
      r[data[i]]++;
      g[data[i + 1]]++;
      b[data[i + 2]]++;
      var av = data[i + 3];
      a[av]++;
      if (av < 255) alpha = true;
    }
    self.postMessage(
      { ok: true, r: r, g: g, b: b, a: a, hasAlpha: alpha },
      [r.buffer, g.buffer, b.buffer, a.buffer]
    );
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
`;
let histWorkerBlobUrl: string | null = null;
function getHistWorkerUrl(): string {
  if (histWorkerBlobUrl) return histWorkerBlobUrl;
  const blob = new Blob([HISTOGRAM_WORKER_SRC], { type: 'application/javascript' });
  histWorkerBlobUrl = URL.createObjectURL(blob);
  return histWorkerBlobUrl;
}

// Fixed slot layout — info no longer migrates between corners. Decided so
// the eye learns where to look, instead of cards jumping per-image based on
// emptiness ranking.
//   TL: capture (camera / lens / shot / date)  — also expanded EXIF panel
//   BL: file    (filename / dims / size / color)
//   TR: gps     (inline map or coord)
//   BR: zoom    (current zoom %)
// Corner luminance is still sampled, but only to drive on-dark/on-light glass
// contrast — not slot assignment.
let lastCursor = { x: -1, y: -1 };

function renderMapThumb(lat: number, lon: number, linkUrl: string | null, label: string): string {
  // The thumbnail is ALWAYS OpenStreetMap tiles (free, keyless, CSP-allowed);
  // gpsMapProvider only picks where a click navigates. Surface that in the
  // tooltip so "provider: google" doesn't read as a mis-rendered thumbnail.
  const providerName =
    ctx.gpsMapProvider === 'google' ? 'Google Maps'
    : ctx.gpsMapProvider === 'apple' ? 'Apple Maps'
    : 'OpenStreetMap';
  const view = computeMapView(lat, lon, 13, 200, 130);
  const tiles = view.tiles.map((t) =>
    `<img class="map-tile" src="${escapeAttr(t.url)}" style="left:${t.left}px;top:${t.top}px" alt="" aria-hidden="true" />`
  ).join('');
  const body = `
    <div class="map-view" style="width:${view.width}px;height:${view.height}px">
      ${tiles}
      <div class="map-marker"></div>
      <div class="map-coord">${escapeHtml(label)}</div>
      <div class="map-attribution">© OpenStreetMap</div>
    </div>
  `;
  return linkUrl
    ? `<a class="map-link" href="${escapeAttr(linkUrl)}" title="Open in ${escapeAttr(providerName)}">${body}</a>`
    : `<div class="map-link static">${body}</div>`;
}

// --- Slot builders. Each returns either complete card HTML or '' if empty. ---

function buildFileHtml(): string {
  const { w, h } = state.natural;
  const e = state.exif || {};
  const ext = getExt(state.filename);
  const lines: string[] = [];
  lines.push(`<div class="title" title="${escapeHtml(state.filename)}">${escapeHtml(state.filename)}</div>`);
  if (w && h) {
    const mp = (w * h / 1e6).toFixed(1);
    const ratio = gcdRatio(w, h);
    lines.push(`<div class="meta big">${w} × ${h}</div>`);
    lines.push(`<div class="meta dim">${ext}${ext ? ' · ' : ''}${fmtSize(state.fileSize)} · ${mp} MP${ratio ? ' · ' + ratio : ''}</div>`);
  } else {
    lines.push(`<div class="meta dim">${ext}${ext ? ' · ' : ''}${fmtSize(state.fileSize)}</div>`);
  }

  const colorMode = describeColorMode(e, state.hasAlpha);
  const colorSpace = describeColorSpace(e);
  const hdrFormat = detectHdr(e);
  // One line that combines color depth/channels, color space, and HDR
  // chip — keeps the file card compact instead of stacking three thin lines.
  const colorParts: string[] = [];
  if (colorMode) colorParts.push(escapeHtml(colorMode));
  if (colorSpace) colorParts.push(escapeHtml(colorSpace));
  const hdrChip = hdrFormat
    ? `<span class="hdr-chip" title="${escapeAttr(hdrFormat)}">HDR</span>`
    : '';
  const colorJoined = colorParts.join(' · ');
  if (colorJoined || hdrChip) {
    const sep = colorJoined && hdrChip ? ' · ' : '';
    lines.push(`<div class="meta dim">${colorJoined}${sep}${hdrChip}</div>`);
  }

  const artist = pick<string>(e, 'Artist', 'Creator');
  const copyright = pick<string>(e, 'Copyright', 'Rights');
  const attribution = [
    copyright ? `© ${escapeHtml(String(copyright))}` : '',
    artist && !copyright ? escapeHtml(String(artist)) : '',
  ].filter(Boolean).join(' · ');
  if (attribution) lines.push(`<div class="meta dim">${attribution}</div>`);

  // Position counter — only when more than one image to browse through.
  if (ctx.siblings.length > 1) {
    lines.push(`<div class="meta dim browse-pos">${state.currentIndex + 1} / ${ctx.siblings.length}</div>`);
  }

  return `<div class="card-section">${lines.join('')}</div>`;
}

function buildCaptureHtml(): string {
  const e = state.exif || {};
  const make = pick<string>(e, 'Make');
  const model = pick<string>(e, 'Model');
  const camera = [make, model].filter(Boolean).join(' ').trim();
  const lens = pick<string>(e, 'LensModel', 'Lens', 'LensInfo');
  const iso = pick<number>(e, 'ISO', 'ISOSpeedRatings');
  const fnum = pick<number>(e, 'FNumber', 'ApertureValue');
  const shutter = fmtExposure(pick(e, 'ExposureTime'));
  const focal = pick<number>(e, 'FocalLength');
  const focal35 = pick<number>(e, 'FocalLengthIn35mmFormat');
  const focalStr = focal
    ? focal35 && Math.round(focal35) !== Math.round(focal)
      ? `${Math.round(focal)}mm (eq. ${Math.round(focal35)}mm)`
      : `${Math.round(focal)}mm`
    : '';
  const shot = [
    focalStr,
    fnum ? `f/${fnum}` : '',
    shutter,
    iso ? `ISO ${iso}` : '',
  ].filter(Boolean).join(' · ');
  const taken = pick(e, 'DateTimeOriginal', 'CreateDate', 'DateTime');

  const lines: string[] = [];
  if (camera) lines.push(`<div class="title">${escapeHtml(camera)}</div>`);
  if (lens) lines.push(`<div class="meta dim">${escapeHtml(String(lens))}</div>`);
  // shot/describeCaptureExtras assemble EXIF numeric fields, but exifr
  // doesn't guarantee their runtime type against a crafted file — escape
  // before they hit innerHTML.
  if (shot) lines.push(`<div class="meta">${escapeHtml(shot)}</div>`);

  for (const line of describeCaptureExtras(e)) {
    lines.push(`<div class="meta dim">${escapeHtml(line)}</div>`);
  }

  if (taken) lines.push(`<div class="meta dim">${escapeHtml(formatMaybeDate(taken))}</div>`);

  if (!lines.length) return '';
  return `<div class="card-section">${lines.join('')}</div>`;
}

function buildGpsHtml(): string {
  const e = state.exif || {};
  const lat = pick<number>(e, 'latitude');
  const lon = pick<number>(e, 'longitude');
  if (typeof lat !== 'number' || typeof lon !== 'number') return '';
  const gpsStr = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  if (ctx.gpsMapProvider === 'none') {
    return `<div class="card-section"><div class="meta dim">◎ ${escapeHtml(gpsStr)}</div></div>`;
  }
  const gpsUrl = mapUrl(lat, lon, ctx.gpsMapProvider);
  return `<div class="card-section has-map">${renderMapThumb(lat, lon, gpsUrl, gpsStr)}</div>`;
}

function buildZoomHtml(): string {
  const pct = Math.round(state.zoom * 100);
  // When slideshow is active, prepend a play-indicator + interval so the
  // user can see the current speed at a glance. When idle, just zoom %.
  if (state.slideshowOn) {
    const sec = (state.slideshowIntervalMs / 1000).toFixed(state.slideshowIntervalMs < 1000 ? 1 : (state.slideshowIntervalMs % 1000 === 0 ? 0 : 1));
    return `<div class="card-section"><div class="meta big zoom-pct"><span class="slideshow-tag">▶ ${sec}s</span> · ${pct}%</div></div>`;
  }
  return `<div class="card-section"><div class="meta big zoom-pct">${pct}%</div></div>`;
}

// Cache of the last HTML committed per corner. render() rebuilds all four
// corner strings on every call (zoom%, EXIF text, etc.), but most of the
// time the string is identical to what's already in the DOM — e.g. panning
// only changes BL/TR content, not BR's zoom% — so skip the innerHTML write
// when nothing actually changed. Class toggles stay unconditional since
// they're cheap and must track the current call either way.
const overlayHtmlCache: Record<CornerKey, string> = { tl: '', tr: '', bl: '', br: '' };

function setOverlay(key: CornerKey, html: string) {
  const node = overlays[key];
  if (overlayHtmlCache[key] !== html) {
    overlayHtmlCache[key] = html;
    node.innerHTML = html;
  }
  if (html) {
    node.classList.remove('empty');
  } else {
    node.classList.add('empty');
  }
}

function render() {
  document.body.classList.toggle('overlay-hidden', !state.visible);
  document.body.classList.toggle('expanded', state.expanded);

  if (state.expanded) {
    // Expanded mode replaces the TL capture card with the full EXIF table.
    // BL/TR are hidden via CSS (body.expanded) rather than emptied — routing
    // their HTML through '' would tear down and rebuild the TR map card's tile
    // <img>s on every expand→collapse round-trip. BR keeps zoom % so the user
    // still has a zoom indicator while inspecting EXIF.
    renderExpanded();
  } else {
    setOverlay('tl', buildCaptureHtml());
    setOverlay('bl', buildFileHtml());
    setOverlay('tr', buildGpsHtml());
  }
  setOverlay('br', buildZoomHtml());

  // Bounding boxes just changed — re-evaluate proximity against the new rects.
  refreshProximity();
}

function updateZoomDisplay() {
  // Cheap re-render of just the BR slot during wheel/keyboard zoom — avoids
  // touching map tiles or capture HTML on every tick.
  setOverlay('br', buildZoomHtml());
}

function renderExpanded() {
  // Expanded mode dumps the full EXIF table into TL — fixed slot, same place
  // the capture card lived, just bigger (see body.expanded .corner.tl in CSS).
  const target: CornerKey = 'tl';
  // Ordered sections — each group shown with a subtle divider
  const sections: Array<{ title: string; keys: string[] }> = [
    {
      title: 'Description',
      keys: ['ImageDescription', 'Title', 'Description', 'UserComment', 'Keywords', 'Subject'],
    },
    {
      title: 'Camera & Lens',
      keys: ['Make', 'Model', 'OwnerName', 'CameraOwnerName', 'BodySerialNumber',
             'LensMake', 'LensModel', 'LensInfo', 'LensSerialNumber'],
    },
    {
      title: 'Exposure',
      keys: ['FocalLength', 'FocalLengthIn35mmFormat', 'FNumber', 'ExposureTime',
             'ISO', 'ExposureProgram', 'ExposureMode', 'ExposureBiasValue',
             'MeteringMode', 'Flash', 'WhiteBalance'],
    },
    {
      title: 'Date & Time',
      keys: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'OffsetTimeOriginal', 'SubSecTimeOriginal'],
    },
    {
      title: 'GPS',
      keys: ['latitude', 'longitude', 'GPSAltitude', 'GPSAltitudeRef',
             'GPSSpeed', 'GPSSpeedRef', 'GPSImgDirection', 'GPSImgDirectionRef',
             'GPSTrack', 'GPSTrackRef', 'GPSMapDatum', 'GPSDateStamp'],
    },
    {
      title: 'Image',
      keys: ['Orientation', 'ColorSpace', 'ProfileDescription', '__hdrFormat',
             'BitDepth', 'ColorType', 'BitsPerSample',
             'XResolution', 'YResolution', 'ResolutionUnit', 'Compression'],
    },
    {
      title: 'Authoring',
      keys: ['Software', 'Artist', 'Creator', 'Copyright', 'Rights'],
    },
  ];
  const e = state.exif || {};
  const lat = pick<number>(e, 'latitude');
  const lon = pick<number>(e, 'longitude');
  const gpsUrl = typeof lat === 'number' && typeof lon === 'number'
    ? mapUrl(lat, lon, ctx.gpsMapProvider) : null;

  const renderedSections: string[] = [];
  for (const section of sections) {
    const rows: string[] = [];
    for (const k of section.keys) {
      const v = e[k];
      if (v == null || v === '') continue;
      let display = v instanceof Date ? v.toLocaleString() : String(v);
      if ((k === 'latitude' || k === 'longitude') && gpsUrl) {
        display = `<a href="${escapeAttr(gpsUrl)}" class="gps-link">${escapeHtml(display)}</a>`;
      } else if (k === 'ColorSpace') {
        // Skip the row when EXIF says Uncalibrated and we have a real
        // ProfileDescription from the format-aware enrichment — showing
        // both "Uncalibrated" and "Rec.2020 PQ" together just confuses.
        const num = typeof v === 'number' ? v : Number(v);
        if (num === 65535 && e.ProfileDescription) continue;
        display = escapeHtml(formatExifColorSpace(v));
      } else {
        display = escapeHtml(display);
      }
      const label = k === '__hdrFormat' ? 'HDR' : k;
      rows.push(`<tr><td>${escapeHtml(label)}</td><td>${display}</td></tr>`);
    }
    if (rows.length) {
      renderedSections.push(
        `<div class="exif-section"><div class="exif-section-title">${section.title}</div>` +
        `<table class="exif-table">${rows.join('')}</table></div>`
      );
    }
  }

  const colorMode = describeColorMode(e, state.hasAlpha);
  const header = `
    <div class="title" title="${escapeHtml(state.filename)}">${escapeHtml(state.filename)}</div>
    <div class="meta dim">${getExt(state.filename)} · ${fmtSize(state.fileSize)} · ${state.natural.w}×${state.natural.h}${colorMode ? ' · ' + escapeHtml(colorMode) : ''}</div>
  `;

  const html = header + (renderedSections.length
    ? renderedSections.join('')
    : `<div class="meta dim" style="margin-top:8px">no EXIF data</div>`);
  // Route through setOverlay (instead of writing innerHTML directly) so
  // overlayHtmlCache stays coherent — otherwise toggling back to the
  // non-expanded capture card could see a stale cached string for 'tl'
  // and skip a write it actually needs to make.
  setOverlay(target, html);
}

// Single downscaled sample that feeds both the per-corner glass tint and
// alpha detection. Merged so a possibly-huge image is rasterized ONCE (one
// drawImage) instead of once per concern. Two distinct responsibilities:
//   - alpha: always runs (except the jpg/jpeg/bmp short-circuit) — it feeds
//     the RGB/RGBA line in the file card regardless of the auto-contrast
//     setting, so the draw + alpha scan are unconditional.
//   - luminance: only when ctx.autoContrast — picks on-dark/on-light glass per
//     corner. When off, both classes are stripped so the base glass applies.
// Note: at a 200×200 downscale, translucency confined to sub-sample-scale
// (~1px in a large source) can be averaged away and missed — an accepted
// trade-off for not rasterizing the full image twice.
async function analyzeImageSample(): Promise<void> {
  const size = 200;
  // Canvas path (TIFF/HEIC): state.hasAlpha was already set from the worker's
  // authoritative full-resolution scan — don't second-guess it with a 200×200
  // downscale (translucency finer than the sample grid would be averaged away).
  const onCanvas = state.presenting === 'canvas';
  const ext = getExt(state.filename).toLowerCase();
  // Formats that structurally can't carry alpha: definitive false up front,
  // independent of whether the canvas read below succeeds. (img path only —
  // the canvas path's alpha is the worker's, left untouched.)
  const alphaCapable = !['jpg', 'jpeg', 'bmp'].includes(ext);
  if (!onCanvas && !alphaCapable) state.hasAlpha = false;

  // Auto-contrast off: no per-corner luminance sampling — strip both tint
  // classes so the neutral base glass applies. When also on the canvas path,
  // there's no alpha work left either, so nothing to draw — bail early.
  if (!ctx.autoContrast) {
    for (const key of Object.keys(overlays) as CornerKey[]) {
      overlays[key].classList.remove('on-dark', 'on-light');
    }
    if (onCanvas) return;
  }

  try {
    const sample = document.createElement('canvas');
    sample.width = size;
    sample.height = size;
    const cctx = sample.getContext('2d');
    if (!cctx) return;
    cctx.drawImage(activeEl(), 0, 0, size, size);

    // Per-corner luminance — used to pick on-dark vs on-light glass tint.
    // No more ranking: slot assignment is fixed (see FIXED_LAYOUT comment).
    if (ctx.autoContrast) {
      const rs = 56;
      const regions: Array<{ key: CornerKey; x: number; y: number }> = [
        { key: 'tl', x: 0, y: 0 },
        { key: 'tr', x: size - rs, y: 0 },
        { key: 'bl', x: 0, y: size - rs },
        { key: 'br', x: size - rs, y: size - rs },
      ];
      for (const r of regions) {
        const data = cctx.getImageData(r.x, r.y, rs, rs).data;
        let sum = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += lum;
          n++;
        }
        const mean = sum / n;
        overlays[r.key].classList.toggle('on-dark', mean < 128);
        overlays[r.key].classList.toggle('on-light', mean >= 128);
      }
    }

    // Alpha — scan the whole downscaled canvas so a fully-opaque image yields
    // false. img path only; the canvas path kept the worker's value above.
    if (!onCanvas && alphaCapable) {
      const data = cctx.getImageData(0, 0, size, size).data;
      let alpha = false;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) { alpha = true; break; }
      }
      state.hasAlpha = alpha;
    }
  } catch (err) {
    console.warn('[image-overlay] image sample failed', err);
    // Corner tint just stays as-is; alpha is unknown → null (so the file card
    // omits the RGB/RGBA line) unless the format short-circuit / worker set it.
    if (!onCanvas && alphaCapable) state.hasAlpha = null;
  }
}

async function loadExif(uri: string): Promise<Record<string, unknown> | null> {
  // Hand the URI directly to exifr instead of pre-fetching the whole file
  // into an ArrayBuffer. exifr's default chunked mode (true for URL input
  // in browser) issues Range requests and only pulls the few segments it
  // needs — a 100 MB image now reads ~64 KB instead of allocating 100 MB
  // on the main thread. Falls back to a full fetch automatically if the
  // underlying transport doesn't honor Range, so no behavioral regression
  // on hosts that don't.
  //
  // Returns the parsed record (or {} when exifr finds nothing) on success and
  // null on failure — the caller commits it to state.exif behind a gen check,
  // so a load superseded by a fast navigate never writes stale data.
  try {
    return await exifr.parse(uri, {
      tiff: true,
      xmp: true,
      iptc: true,
      // ICC profile parse — small (~3 KB) and the only reliable source for
      // "Display P3" / "Adobe RGB" / etc. since EXIF ColorSpace falls back
      // to "Uncalibrated" on those.
      icc: true,
      gps: true,
      ihdr: true,
      jfif: true,
      translateValues: true,
      reviveValues: true,
    }) || {};
  } catch (err) {
    console.warn('[image-overlay] exif parse failed', err);
    return null;
  }
}

// Second pass after exifr: read AVIF/HEIC nclx and PNG cICP/iCCP signals
// that exifr can't surface. Returns keys to fold onto state.exif so
// describeColorSpace and detectHdr pick them up unchanged (or {} when there's
// nothing to add). The caller merges the result behind a gen check, so this
// no longer takes/tracks a generation itself.
//
// Per-format head budget: PNG cICP/iCCP chunks live before IDAT near the very
// start (256 KB is generous), while ISOBMFF meta boxes can sit deeper, so
// HEIC/AVIF keep a 1 MB window.
const ENRICH_HEAD_PNG = 262_144;
const ENRICH_HEAD_ISOBMFF = 1_048_576;

async function enrichExifFromFormat(uri: string, name: string): Promise<Record<string, unknown>> {
  const ext = getExt(name).toLowerCase();
  if (!['heic', 'heif', 'avif', 'png'].includes(ext)) return {};
  const limit = ext === 'png' ? ENRICH_HEAD_PNG : ENRICH_HEAD_ISOBMFF;
  try {
    // Ask for just the head with a Range header. VS Code's webview service
    // worker likely ignores Range, though — and then res.arrayBuffer() would
    // allocate the WHOLE file to read ~7 bytes. So when the body is a
    // readable stream, pull chunks only until we have `limit` bytes and
    // cancel the rest; fall back to arrayBuffer + slice only when it isn't.
    const res = await fetch(uri, { headers: { Range: `bytes=0-${limit - 1}` } });
    if (!res.ok) return {};
    let head: Uint8Array;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (received >= limit) { await reader.cancel(); break; }
        }
      }
      const merged = new Uint8Array(received);
      let offset = 0;
      for (const c of chunks) { merged.set(c, offset); offset += c.length; }
      head = merged.length > limit ? merged.subarray(0, limit) : merged;
    } else {
      const full = new Uint8Array(await res.arrayBuffer());
      head = full.length > limit ? full.subarray(0, limit) : full;
    }
    return enrichFromBytes(head, ext);
  } catch (err) {
    console.warn('[image-overlay] format enrichment failed', err);
    return {};
  }
}

function applyTransform() {
  // Pan is a translate on the wrapper — translate never GPU-tiles. Zoom
  // is applied as explicit pixel width/height on the <img>; the browser
  // rasterizes at the actual display size so the compositor never scales
  // a tiled bitmap (which is what produced the 1px tile-seam lines on
  // large photos at non-integer scales).
  imgWrap.style.transform = `translate(${state.panX}px, ${state.panY}px)`;

  // Show the live surface, hide the other. The explicit-pixel sizing that
  // dodges the GPU tile-seam bug is applied to whichever element is active.
  const el = activeEl();
  const other = el === img ? canvas : img;
  other.style.display = 'none';
  el.style.display = '';

  if (state.natural.w && state.natural.h) {
    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    // Default fit: contain in stage, never blow up past natural size at
    // zoom=1 (matches the previous max-width/max-height: 100% behavior).
    const fitScale = Math.min(
      stageW / state.natural.w,
      stageH / state.natural.h,
      1,
    );
    const display = fitScale * state.zoom;
    el.style.maxWidth = 'none';
    el.style.maxHeight = 'none';
    el.style.width = `${state.natural.w * display}px`;
    el.style.height = `${state.natural.h * display}px`;
  } else {
    // No natural dims yet — let CSS max-width/max-height handle it.
    el.style.width = '';
    el.style.height = '';
    el.style.maxWidth = '';
    el.style.maxHeight = '';
  }

  updateZoomDisplay();
}

// --- Decoder workers (HEIC and TIFF, each in its own Web Worker) ---
// Chromium renders neither TIFF nor HEIC in an <img>. Each format has its own
// long-lived Web Worker that decodes bytes → RGBA; we present that straight
// onto <canvas> (no PNG re-encode round-trip). The worker bundles are their
// own esbuild entrypoints, lazy-fetched the first time such a file opens. Both
// the request buffer (in) and the RGBA (out) cross the boundary as
// Transferables, so we never pay for a full-image copy.

interface DecodeResult {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  hasAlpha: boolean;
}

// One persistent decode worker + its request/response plumbing. Two instances
// exist (HEIC, TIFF). The worker is long-lived and processes many requests; a
// per-request decode failure returns { ok:false } and does NOT poison it. Only
// a hard worker 'error' (crash) discards it: every in-flight promise rejects
// and the next decode() lazily respawns.
class DecodeWorkerClient {
  private readonly workerUri: string;
  private worker: Worker | null = null;
  // The fetched-and-wrapped bundle blob URL. Kept across respawns so a crash
  // doesn't force a re-fetch of the (up to ~1.4 MB) worker bundle.
  private blobUrl: string | null = null;
  private booting: Promise<Worker> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (r: DecodeResult) => void;
    reject: (e: Error) => void;
  }>();

  constructor(workerUri: string) {
    this.workerUri = workerUri;
  }

  // Pending-request count — prefetch gates on this so a background pre-decode
  // never front-runs (or piles up behind another decode on) the same worker.
  get busy(): number {
    return this.pending.size;
  }

  // Fire-and-forget spawn (bundle fetch + Worker creation) so a cold open can
  // overlap it with the image-byte fetch instead of serializing after it.
  // WASM init inside the worker stays lazy (first request), but the
  // up-to-1.4 MB bundle fetch leaves the critical path. Arms the idle timer
  // so a warm() with no follow-up decode still gets freed.
  warm(): void {
    this.boot()
      .then(() => { if (this.pending.size === 0) this.armIdleTimer(); })
      .catch(() => { /* next decode() retries and surfaces the error */ });
  }

  // Free the worker (and its WASM heap) after a quiet minute.
  // retainContextWhenHidden keeps webviews alive in the background — without
  // this, every webview that ever decoded a HEIC would pin a libheif instance
  // forever. blobUrl survives, so the next decode respawns without re-fetching
  // the bundle.
  private idleTimer: number | null = null;
  private clearIdleTimer(): void {
    if (this.idleTimer != null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && this.worker) {
        this.worker.terminate();
        this.worker = null;
      }
    }, 60_000);
  }

  private boot(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.booting) return this.booting;
    const booting = (async () => {
      // Same-origin blob trick: webview-resource URIs live on a different
      // origin (*.vscode-cdn.net) than the page (vscode-webview://…), and
      // new Worker(url) enforces same-origin. Fetch the bundle as text, wrap
      // it in a Blob, and spawn from the blob URL — blob URLs inherit the page
      // origin, so the same-origin check passes.
      if (!this.blobUrl) {
        const res = await fetch(this.workerUri);
        if (!res.ok) throw new Error(`worker fetch ${res.status}`);
        const src = await res.text();
        this.blobUrl = URL.createObjectURL(
          new Blob([src], { type: 'application/javascript' }),
        );
      }
      const worker = new Worker(this.blobUrl);
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as
          | { id: number; ok: true; rgba: Uint8ClampedArray | Uint8Array; width: number; height: number; hasAlpha: boolean }
          | { id: number; ok: false; error: string };
        const entry = this.pending.get(d.id);
        if (!entry) return;   // stale / already-settled id
        this.pending.delete(d.id);
        if (d.ok) entry.resolve({ rgba: d.rgba, width: d.width, height: d.height, hasAlpha: d.hasAlpha });
        else entry.reject(new Error(d.error));
        if (this.pending.size === 0) this.armIdleTimer();
      };
      worker.onerror = (ev: ErrorEvent) => {
        // Hard crash (WASM abort, OOM, …). ErrorEvent fields are sparse for
        // cross-origin workers, so concatenate whatever is present. Reject
        // ALL in-flight requests and discard the worker — boot() respawns it
        // on the next decode(). blobUrl is retained so we don't re-fetch.
        const detail =
          ev.message ||
          (ev.filename ? `${ev.filename}:${ev.lineno || '?'}` : '') ||
          'worker error';
        const err = new Error(detail);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.clearIdleTimer();
        if (this.worker === worker) this.worker = null;
        worker.terminate();
      };
      this.worker = worker;
      return worker;
    })();
    this.booting = booting;
    // Clear the boot latch on both settle paths: on success this.worker is set
    // (fast path next time); on failure this.worker stays null so the next
    // decode() retries the fetch+spawn.
    booting.then(() => { this.booting = null; }, () => { this.booting = null; });
    return booting;
  }

  async decode(buffer: ArrayBuffer): Promise<DecodeResult> {
    this.clearIdleTimer();
    const worker = await this.boot();
    const id = this.nextId++;
    return new Promise<DecodeResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // Transfer the request buffer in; the worker transfers RGBA back out.
      worker.postMessage({ id, buffer }, [buffer]);
    });
  }
}

const heicClient = new DecodeWorkerClient(ctx.heicWorkerUri);
const tiffClient = new DecodeWorkerClient(ctx.tiffWorkerUri);

function decoderClientFor(name: string): DecodeWorkerClient | null {
  if (isTiffName(name)) return tiffClient;
  if (isHeicName(name)) return heicClient;
  return null;
}

function toClamped(rgba: Uint8ClampedArray | Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  // The worker allocates a plain ArrayBuffer (never SharedArrayBuffer), so the
  // ArrayBufferLike → ArrayBuffer cast is safe and satisfies the ImageData
  // constructor's element type (the explicit <ArrayBuffer> return keeps the
  // buffer kind from widening back to ArrayBufferLike). Viewing through buffer
  // + byteOffset avoids copying the full RGBA (~4·W·H bytes — 100 MB on a big
  // TIFF).
  return new Uint8ClampedArray(
    rgba.buffer as ArrayBuffer,
    rgba.byteOffset,
    rgba.byteLength,
  );
}

// --- Decoded-neighbor cache (TIFF/HEIC pre-decode) ---
// Keyed by webview URI. Holds the foreground plus pre-decoded neighbors so ←/→
// and slideshow swaps to a TIFF/HEIC paint from a cached bitmap instead of a
// cold fetch+decode. Bounded two ways: at most DECODED_MAX_ENTRIES entries, and
// at most DECODED_MAX_PIXELS total pixels (≈128 MB RGBA) — a single decode
// larger than that budget is never cached at all.
interface DecodedEntry {
  bitmap: ImageBitmap;
  w: number;
  h: number;
  hasAlpha: boolean;
}
const decodedCache = new Map<string, DecodedEntry>();
const DECODED_MAX_ENTRIES = 2;
const DECODED_MAX_PIXELS = 33_000_000;

// fileUpdate cache-busted URIs (…?v=N / …&v=N) are one-shot: never cache or
// prefetch them, and when a bust arrives evict the plain-URI entry — a
// navigate-away-and-back must not repaint the pre-edit pixels.
function isBustedUri(uri: string): boolean {
  return /[?&]v=\d+$/.test(uri);
}

function evictDecoded(uri: string): void {
  const entry = decodedCache.get(uri);
  if (entry) {
    entry.bitmap.close();
    decodedCache.delete(uri);
  }
}

// In-flight decode registry. A foreground open whose uri is already being
// pre-decoded RIDES that promise instead of posting a duplicate decode behind
// it — without this, browsing faster than a decode completes made every swap
// pay the full decode twice (prefetch + foreground, serialized on one worker).
const inflightDecodes = new Map<string, Promise<void>>();

function decodedPixelTotal(): number {
  let total = 0;
  for (const e of decodedCache.values()) total += e.w * e.h;
  return total;
}

// URIs worth keeping decoded: the current image plus its immediate neighbors
// (honoring browseLoop). The live currentUri is included too — it may be a
// `?v=` cache-busted variant that isn't in ctx.siblings.
function wantedDecodedUris(): Set<string> {
  const wanted = new Set<string>();
  if (state.currentUri) wanted.add(state.currentUri);
  const n = ctx.siblings.length;
  const cur = state.currentIndex;
  const curSib = ctx.siblings[cur];
  if (curSib) wanted.add(curSib.uri);
  for (const dir of [-1, 1] as const) {
    let idx = cur + dir;
    if (idx < 0) idx = ctx.browseLoop ? n - 1 : -1;
    else if (idx >= n) idx = ctx.browseLoop ? 0 : -1;
    if (idx < 0 || idx === cur) continue;
    const sib = ctx.siblings[idx];
    if (sib) wanted.add(sib.uri);
  }
  return wanted;
}

// Drop decoded entries no longer current-or-neighbor, freeing their GPU-backed
// bitmaps. Mirrors the native prefetchCache wanted-set eviction below.
function pruneDecodedCache(): void {
  const wanted = wantedDecodedUris();
  for (const [key, entry] of [...decodedCache]) {
    if (!wanted.has(key)) {
      entry.bitmap.close();
      decodedCache.delete(key);
    }
  }
}

// Try to retain a decoded result. Returns true ONLY if the cache took ownership
// of *this* `bitmap` (caller must NOT close it); false means the caller still
// owns `bitmap` and must close it after presenting. Prunes non-wanted entries
// first so the current image can claim a freed slot.
function retainDecoded(
  uri: string, bitmap: ImageBitmap, w: number, h: number,
  hasAlpha: boolean,
): boolean {
  // Already cached (e.g. a prefetch for this same uri landed first): keep the
  // existing entry, hand ownership of this fresh duplicate back to the caller.
  if (decodedCache.has(uri)) return false;
  if (isBustedUri(uri)) return false;                // one-shot fileUpdate uri
  if (w * h > DECODED_MAX_PIXELS) return false;      // oversized: never cache
  pruneDecodedCache();
  if (decodedCache.size >= DECODED_MAX_ENTRIES) return false;
  if (decodedPixelTotal() + w * h > DECODED_MAX_PIXELS) return false;
  decodedCache.set(uri, { bitmap, w, h, hasAlpha });
  return true;
}

// Unified image loader. Native formats go straight to <img>.src; TIFF/HEIC go
// through their decode worker onto <canvas>. Either way the settle sequence
// (settleImage) runs once the pixels are actually up, so nav, fileUpdate and
// the initial load all share one gen-token race guard.
function loadImageInto(uri: string, name: string): void {
  state.loadGen += 1;
  const myGen = state.loadGen;

  const client = decoderClientFor(name);
  if (client) {
    const label = isTiffName(name) ? 'TIFF' : 'HEIC';
    const cached = decodedCache.get(uri);
    if (cached) {
      // Cache hit — no fetch, no decode. The only work left at swap time is a
      // single drawImage onto the canvas + the settle pass.
      presentDecoded(cached.bitmap, cached.w, cached.h, cached.hasAlpha, myGen, /*retained*/ true);
      return;
    }
    // Miss. Warm the worker now (bundle fetch + spawn) so it overlaps the
    // image-byte fetch instead of serializing after it on a cold open.
    client.warm();
    // Blank the <img> (it carries no src for these formats) and mark it
    // active so a canvas→canvas swap doesn't flash the previous decoded frame
    // while the fetch+decode runs; presentDecoded flips back to the canvas.
    img.removeAttribute('src');
    state.presenting = 'img';
    void decodeAndPresent(client, uri, label, myGen);
    return;
  }

  // Native format: <img> path.
  const onLoad = () => {
    if (myGen !== state.loadGen) return;
    void settleImage(myGen, state.currentUri, state.filename);
  };
  img.addEventListener('load', onLoad, { once: true });
  state.presenting = 'img';
  img.src = uri;
}

// Fetch → worker-decode → ImageBitmap → present onto the canvas. Gen-guarded at
// every await, so a fast ←/→ that supersedes this load discards the stale
// result (closing the bitmap) instead of painting it. A per-decode failure
// lands in the catch and shows the TL error card (+ advances the slideshow).
async function decodeAndPresent(client: DecodeWorkerClient, uri: string, label: string, myGen: number): Promise<void> {
  try {
    // A background pre-decode of this exact uri may be mid-flight — ride it.
    // When it lands in the cache, present from there; if it finished but
    // couldn't cache (oversized / budget / failed), fall through to a decode
    // of our own.
    const inflight = inflightDecodes.get(uri);
    if (inflight) {
      await inflight;
      if (myGen !== state.loadGen) return;
      const cached = decodedCache.get(uri);
      if (cached) {
        presentDecoded(cached.bitmap, cached.w, cached.h, cached.hasAlpha, myGen, /*retained*/ true);
        return;
      }
    }
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buf = await res.arrayBuffer();
    if (myGen !== state.loadGen) return;
    const decoded = await client.decode(buf);
    if (myGen !== state.loadGen) return;
    const pixels = toClamped(decoded.rgba);
    const bitmap = await createImageBitmap(new ImageData(pixels, decoded.width, decoded.height));
    if (myGen !== state.loadGen) { bitmap.close(); return; }
    // Retain first so a later revisit reuses this exact bitmap; if the budget
    // rejects it we still present, then presentDecoded closes it after the draw.
    const retained = retainDecoded(uri, bitmap, decoded.width, decoded.height, decoded.hasAlpha);
    presentDecoded(bitmap, decoded.width, decoded.height, decoded.hasAlpha, myGen, retained);
  } catch (err) {
    if (myGen !== state.loadGen) return;   // superseded — stay silent
    console.warn(`[image-overlay] ${label} decode failed`, err);
    showDecodeError(label, err);
  }
}

// Draw a decoded bitmap onto the canvas and run the shared settle pass. Uses
// drawImage (NOT transferFromImageBitmap, which would consume the bitmap and
// break cache reuse). When `retained` is false the bitmap is a throwaway the
// cache declined — close it right after the synchronous draw.
function presentDecoded(
  bitmap: ImageBitmap, w: number, h: number, hasAlpha: boolean,
  myGen: number, retained: boolean,
): void {
  if (myGen !== state.loadGen) { if (!retained) bitmap.close(); return; }
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext('2d');
  if (!cctx) {
    if (!retained) bitmap.close();
    showDecodeError('decode', new Error('no canvas 2d ctx'));
    return;
  }
  cctx.drawImage(bitmap, 0, 0);
  if (!retained) bitmap.close();
  // Worker's full-res hasAlpha is authoritative; natural dims come from the
  // decode, not from any <img>. presenting flips to canvas so activeEl(), the
  // sampler and the histogram all target it.
  state.natural.w = w;
  state.natural.h = h;
  state.hasAlpha = hasAlpha;
  state.presenting = 'canvas';
  void settleImage(myGen, state.currentUri, state.filename);
}

function showDecodeError(label: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  // Surface the underlying message in the TL card — without it a bug report
  // has no signal beyond "didn't work".
  overlays.tl.innerHTML = `
    <div class="title">${escapeHtml(state.filename)}</div>
    <div class="meta dim">${label} decode failed</div>
    <div class="meta dim" style="font-size:10px;opacity:0.7;word-break:break-word;">${escapeHtml(detail)}</div>`;
  overlays.tl.classList.remove('empty');
  // No settle runs on a failed decode, so pace the slideshow from here or a
  // broken file would stall the show forever on the image that never decoded.
  if (state.slideshowOn) scheduleSlideshowTick();
}

// Shared settle pass — the single sequence both the <img> 'load' listener and
// the canvas decode path funnel into, so gen semantics are identical for native
// and decoder formats. myGen / uri / name are snapshotted by the caller at the
// moment the pixels became ready; a newer navigate that bumped loadGen drops
// this whole result at the gen check below.
async function settleImage(myGen: number, uri: string, name: string): Promise<void> {
  // Natural dims: the <img> path reads them off the element now; the canvas
  // path already set state.natural in presentDecoded from the decode result.
  if (state.presenting === 'img') {
    state.natural.w = img.naturalWidth;
    state.natural.h = img.naturalHeight;
  }
  // Now that natural dimensions are known, switch from CSS max-width/max-height
  // to explicit pixel sizing — that's what avoids the GPU tile-seam bug.
  applyTransform();
  await analyzeImageSample();
  render();
  // EXIF parse and format enrichment are independent reads of the same file,
  // so run them concurrently. Both RETURN their data now (rather than mutating
  // state.exif), which lets a superseded load be discarded wholesale by one
  // gen check before anything is committed.
  const [exif, extra] = await Promise.all([
    loadExif(uri),
    enrichExifFromFormat(uri, name),
  ]);
  if (myGen !== state.loadGen) return;   // a newer navigate won — drop this
  // Merge preserves the old sequential outcome: enrichment (when non-empty)
  // folds over the exif result; an exif failure with nothing to add stays null.
  const extraKeys = Object.keys(extra).length;
  if (exif === null && extraKeys === 0) {
    state.exif = null;
  } else if (extraKeys > 0) {
    state.exif = { ...(exif || {}), ...extra };
  } else {
    state.exif = exif;
  }
  render();
  // If the histogram is currently enabled, re-scan for the new image.
  // Discards any in-flight scan via the generation token.
  if (histState.on) {
    void refreshHistogram();
  }
  // Image is settled and the gen is still current (guarded above) — warm the
  // immediate neighbors so ←/→ and slideshow swaps show pixels instantly.
  schedulePrefetch();
  // Slideshow pacing: the tick no longer self-reschedules — it schedules the
  // next advance only once the swap has actually settled here (and this load
  // wasn't superseded, guarded above). That's what stops a short interval from
  // racing past slow-decoding images.
  if (state.slideshowOn) scheduleSlideshowTick();
}

// --- Histogram (full-pixel scan, opt-in via H) ---

const histPanel = document.getElementById('histogram') as HTMLDivElement;
const histCanvas = histPanel.querySelector('canvas') as HTMLCanvasElement;
const histStatus = histPanel.querySelector('.hist-status') as HTMLDivElement;

function setHistCanvasSize(): void {
  // 320×120 logical, scaled for hi-DPI so the curves are crisp on retina.
  const dpr = window.devicePixelRatio || 1;
  histCanvas.width = Math.round(320 * dpr);
  histCanvas.height = Math.round(120 * dpr);
  histCanvas.style.width = '320px';
  histCanvas.style.height = '120px';
}

async function computeHistogram(myGen: number): Promise<HistData | null> {
  // Dimensions from state.natural, which is authoritative for both surfaces
  // (a <canvas> has no naturalWidth). activeEl() feeds the pixel source below.
  const w = state.natural.w;
  const h = state.natural.h;
  if (!w || !h) return null;

  // --- Path A (preferred): createImageBitmap → Worker w/ OffscreenCanvas.
  // The bitmap is decoded asynchronously by the browser and transferred
  // (zero-copy) into the worker, which does drawImage + getImageData
  // entirely off-thread. Main thread sees only one cheap async hop.
  // Modern Chromium (and therefore VS Code's webview) supports both APIs;
  // the feature-checks here are belt-and-suspenders.
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(activeEl());
      if (myGen !== histState.gen) { bitmap.close(); return null; }
      return await runHistogramWorker(
        { bitmap, width: w, height: h },
        [bitmap],
        myGen,
      );
    } catch (err) {
      console.warn('[image-overlay] off-thread bitmap path failed, falling back to main-thread canvas', err);
    }
  }

  // --- Path B (fallback): main-thread canvas → ArrayBuffer transfer to
  // worker. Slower because drawImage + getImageData run synchronously here,
  // but still better than counting on the main thread.
  let imgData: ImageData;
  try {
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const cctx = scratch.getContext('2d', { willReadFrequently: false });
    if (!cctx) return null;
    cctx.drawImage(activeEl(), 0, 0);
    imgData = cctx.getImageData(0, 0, w, h);
  } catch (err) {
    console.warn('[image-overlay] histogram: canvas/getImageData failed', err);
    return null;
  }
  if (myGen !== histState.gen) return null;

  try {
    return await runHistogramWorker(
      { buffer: imgData.data.buffer, length: imgData.data.length },
      [imgData.data.buffer],
      myGen,
    );
  } catch (err) {
    console.warn('[image-overlay] histogram worker failed; falling back to chunked main thread', err);
    return computeOnMainThread(imgData.data, myGen);
  }
}

// One worker per scan, terminated when done. Worker spawn is cheap (the
// blob URL is cached) and one-shot semantics keep the lifecycle simple —
// no cancellation tokens to thread through, just ignore late results via
// the histState.gen check.
function runHistogramWorker(
  payload: object,
  transfers: Transferable[],
  myGen: number,
): Promise<HistData | null> {
  return new Promise<HistData | null>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(getHistWorkerUrl());
    } catch (err) { reject(err); return; }

    let settled = false;
    const cancelTick = window.setInterval(() => {
      if (settled) return;
      if (myGen !== histState.gen) {
        settled = true;
        window.clearInterval(cancelTick);
        worker.terminate();
        resolve(null);
      }
    }, 50);

    worker.onmessage = (e: MessageEvent) => {
      if (settled) return;
      settled = true;
      window.clearInterval(cancelTick);
      worker.terminate();
      const d = e.data as
        | { ok: true; r: Uint32Array; g: Uint32Array; b: Uint32Array; a: Uint32Array; hasAlpha: boolean }
        | { ok: false; error: string };
      if (!d.ok) { reject(new Error(d.error)); return; }
      if (myGen !== histState.gen) { resolve(null); return; }
      // Typed arrays come back already reconstructed against the
      // transferred buffers — no need to wrap them again.
      resolve({ r: d.r, g: d.g, b: d.b, a: d.a, hasAlpha: d.hasAlpha });
    };
    worker.onerror = (err) => {
      if (settled) return;
      settled = true;
      window.clearInterval(cancelTick);
      worker.terminate();
      reject(err);
    };

    worker.postMessage(payload, transfers);
  });
}

async function computeOnMainThread(data: Uint8ClampedArray, myGen: number): Promise<HistData | null> {
  // Fallback path. Larger chunks (4M bytes ≈ 1M pixels) than the previous
  // version to amortize the ~4ms setTimeout(0) minimum that browsers
  // enforce — fewer yields, less wall-clock overhead on huge images.
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const a = new Uint32Array(256);
  let alphaPresent = false;
  const len = data.length;
  const chunkBytes = 4_000_000;
  for (let i = 0; i < len; i += chunkBytes) {
    if (myGen !== histState.gen) return null;
    const end = Math.min(i + chunkBytes, len);
    for (let j = i; j < end; j += 4) {
      r[data[j]]++;
      g[data[j + 1]]++;
      b[data[j + 2]]++;
      const av = data[j + 3];
      a[av]++;
      if (av < 255) alphaPresent = true;
    }
    if (end < len) await new Promise((res) => setTimeout(res, 0));
  }
  return { r, g, b, a, hasAlpha: alphaPresent };
}

function drawHistogram(hist: HistData | null): void {
  const cctx = histCanvas.getContext('2d');
  if (!cctx) return;
  const w = histCanvas.width;
  const h = histCanvas.height;
  cctx.clearRect(0, 0, w, h);
  if (!hist) return;

  // sqrt scale — without this, a single 0/255 spike (common in synthetic /
  // logo / screenshot images) flattens the rest of the curve to nothing.
  // Skip bin 0 and 255 when finding the max so peaks at the extremes don't
  // blow out the dynamic range either.
  const channels: Array<[Uint32Array, string]> = [
    [hist.r, 'rgba(255, 70, 70, 0.55)'],
    [hist.g, 'rgba(80, 220, 80, 0.55)'],
    [hist.b, 'rgba(70, 150, 255, 0.55)'],
  ];
  let peak = 1;
  for (const [arr] of channels) {
    for (let i = 1; i < 255; i++) if (arr[i] > peak) peak = arr[i];
  }
  const peakSqrt = Math.sqrt(peak);

  // Additive blending so overlapping channels read as lighter / whiter.
  cctx.globalCompositeOperation = 'lighter';
  for (const [arr, color] of channels) {
    cctx.fillStyle = color;
    cctx.beginPath();
    cctx.moveTo(0, h);
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = h - Math.min(1, Math.sqrt(arr[i]) / peakSqrt) * h;
      cctx.lineTo(x, y);
    }
    cctx.lineTo(w, h);
    cctx.closePath();
    cctx.fill();
  }
  cctx.globalCompositeOperation = 'source-over';

  // Alpha overlay — only when the image actually has translucency,
  // otherwise it's just a vertical line at 255 that adds noise.
  if (hist.hasAlpha) {
    let aPeak = 1;
    for (let i = 0; i < 256; i++) if (hist.a[i] > aPeak) aPeak = hist.a[i];
    const aPeakSqrt = Math.sqrt(aPeak);
    cctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    cctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1));
    cctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = h - Math.min(1, Math.sqrt(hist.a[i]) / aPeakSqrt) * h;
      if (i === 0) cctx.moveTo(x, y);
      else cctx.lineTo(x, y);
    }
    cctx.stroke();
  }
}

async function refreshHistogram(): Promise<void> {
  histState.gen += 1;
  const myGen = histState.gen;
  // Make sure the canvas has a size before any drawHistogram call further
  // down — covers both the toggle path and the auto-init path where this
  // function may run before the bottom-of-file init block does.
  setHistCanvasSize();
  // Don't clear `histState.computed` or repaint with null — we want to keep
  // the previous histogram visible while the new scan runs, so navigating
  // doesn't flash an empty box. The "computing…" status overlay (faded
  // canvas underneath) is enough of a cue that work is happening.
  histPanel.classList.add('on', 'computing');
  histStatus.textContent = 'computing…';

  const result = await computeHistogram(myGen);
  if (myGen !== histState.gen) return;            // superseded mid-scan
  if (!result) {
    histStatus.textContent = 'unavailable';
    histPanel.classList.remove('computing');
    return;
  }
  histState.computed = result;
  histPanel.classList.remove('computing');
  histStatus.textContent = '';
  drawHistogram(result);
}

function toggleHistogram(): void {
  if (histState.on) {
    histState.on = false;
    // Bump generation so any in-flight scan bails before committing.
    histState.gen += 1;
    histState.computed = null;
    histPanel.classList.remove('on', 'computing');
  } else {
    histState.on = true;
    setHistCanvasSize();
    void refreshHistogram();
  }
  // Mirror the new state back to the extension host so the next webview
  // (e.g. when the user opens a different image from Explorer) inherits it.
  vscodeApi.postMessage({ type: 'histogramToggle', value: histState.on });
}

// If the host says histogram should be on at startup, seed the panel
// immediately. The actual scan happens later inside settleImage once the
// natural size is known.
if (histState.on) {
  setHistCanvasSize();
  histPanel.classList.add('on');
}

// Window resize: recompute fit-to-stage sizing, and redraw histogram if
// it's on. RAF-coalesced so a window-drag doesn't trigger ten resizes.
let resizeRafId: number | null = null;
window.addEventListener('resize', () => {
  if (resizeRafId != null) cancelAnimationFrame(resizeRafId);
  resizeRafId = requestAnimationFrame(() => {
    resizeRafId = null;
    applyTransform();
    if (histState.on) {
      setHistCanvasSize();
      drawHistogram(histState.computed);
    }
  });
});

// Initial load. TIFF/HEIC route through loadImageInto's decoder path onto the
// canvas (the provider emits no <img> src for them). For natively-supported
// formats, if the inline src already finished loading by the time JS runs,
// fast-path straight into the settle pass; otherwise wait for the load event.
if (isTiffName(state.filename) || isHeicName(state.filename)) {
  loadImageInto(state.currentUri, state.filename);
} else {
  state.loadGen += 1;
  const initGen = state.loadGen;
  state.presenting = 'img';
  if (img.complete && img.naturalWidth > 0) {
    void settleImage(initGen, state.currentUri, state.filename);
  } else {
    img.addEventListener('load', () => {
      if (initGen !== state.loadGen) return;
      void settleImage(initGen, state.currentUri, state.filename);
    }, { once: true });
  }
}

img.addEventListener('error', () => {
  // The <img> only ever carries a src for natively-renderable formats now —
  // TIFF/HEIC decode straight to <canvas> and the <img> stays src-less, so it
  // never fires a spurious error for them. If the canvas is the live surface,
  // this is a stale event from a prior native src — ignore it.
  if (state.presenting !== 'img') return;
  // During a TIFF/HEIC fetch+decode the canvas isn't live yet (presenting is
  // briefly 'img' with a blanked src), so an abort-error from the previous
  // native src can still land here. Those formats report real failures via
  // showDecodeError, never this handler.
  if (isTiffName(state.filename) || isHeicName(state.filename)) return;
  overlays.tl.innerHTML = `
    <div class="title">${escapeHtml(state.filename)}</div>
    <div class="meta dim">failed to load preview</div>`;
  overlays.tl.classList.remove('empty');
  // A broken native-format image never reaches the settle pass, so keep the
  // slideshow moving from here.
  if (state.slideshowOn) scheduleSlideshowTick();
});

// --- rAF-coalesced DOM work for high-frequency input ---
// Wheel zoom, drag-pan and cursor-proximity handlers below keep doing their
// math / state updates synchronously per event (cursor-centered zoom always
// reads the latest state; panX/panY track every pointermove) — only the
// resulting DOM work is deferred to run at most once per frame:
// applyTransform() (style writes) then updateCornerProximity() (4x
// getBoundingClientRect reads). Writes before reads means a frame with both
// pan and cursor movement forces layout once, not once per event. Mirrors
// the rAF-id-guard style of the window resize handler above.
let inputRafId: number | null = null;
let transformPending = false;
let proximityPending = false;

function flushInputFrame() {
  inputRafId = null;
  if (transformPending) {
    transformPending = false;
    applyTransform();
  }
  if (proximityPending) {
    proximityPending = false;
    updateCornerProximity(lastCursor.x, lastCursor.y);
  }
}

function scheduleApplyTransform() {
  transformPending = true;
  if (inputRafId == null) inputRafId = requestAnimationFrame(flushInputFrame);
}

function scheduleProximityUpdate() {
  proximityPending = true;
  if (inputRafId == null) inputRafId = requestAnimationFrame(flushInputFrame);
}

// Cursor-centered zoom: keep the image-space point under the cursor fixed
// across the zoom step. Without this the image just grows/shrinks toward
// the stage centre, which feels disconnected when you're inspecting a
// specific region.
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = -Math.sign(e.deltaY) * 0.12;
  const oldZoom = state.zoom;
  const newZoom = Math.max(0.05, Math.min(32, oldZoom * (1 + delta)));
  if (newZoom === oldZoom) return;
  const k = newZoom / oldZoom;
  const rect = stage.getBoundingClientRect();
  const cx = e.clientX - rect.left - rect.width / 2;
  const cy = e.clientY - rect.top - rect.height / 2;
  state.zoom = newZoom;
  state.panX = state.panX * k + (1 - k) * cx;
  state.panY = state.panY * k + (1 - k) * cy;
  scheduleApplyTransform();
}, { passive: false });

// Drag-to-pan via Pointer Events. setPointerCapture means we keep getting
// pointermove/pointerup even if the user releases outside the webview
// iframe (or outside VS Code entirely) — without it the mouseup event
// vanishes and `dragging` stays true, sticking the image to the cursor.
let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
let dragPointerId = -1;
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.pointerType === 'touch') return;
  state.dragging = true;
  dragPointerId = e.pointerId;
  stage.setPointerCapture(e.pointerId);
  dragStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
  stage.classList.add('dragging');
});
stage.addEventListener('pointermove', (e) => {
  if (!state.dragging || e.pointerId !== dragPointerId) return;
  state.panX = dragStart.panX + (e.clientX - dragStart.x);
  state.panY = dragStart.panY + (e.clientY - dragStart.y);
  scheduleApplyTransform();
});
function endDrag(e: PointerEvent) {
  if (!state.dragging || e.pointerId !== dragPointerId) return;
  state.dragging = false;
  dragPointerId = -1;
  stage.classList.remove('dragging');
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);

// Block native HTML5 drag-and-drop so the browser doesn't take over with
// a "drag this image elsewhere" ghost when the user is just trying to pan.
img.draggable = false;
stage.addEventListener('dragstart', (e) => e.preventDefault());

stage.addEventListener('dblclick', () => {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  applyTransform();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'i' || e.key === 'I') {
    state.visible = !state.visible;
    render();
  } else if (e.key === 'e' || e.key === 'E') {
    state.expanded = !state.expanded;
    render();
  } else if (e.key === 'h' || e.key === 'H') {
    toggleHistogram();
  } else if (e.key === '0') {
    state.zoom = 1; state.panX = 0; state.panY = 0;
    applyTransform();
  } else if (e.key === '+' || e.key === '=') {
    state.zoom = Math.min(32, state.zoom * 1.2); applyTransform();
  } else if (e.key === '-' || e.key === '_') {
    state.zoom = Math.max(0.05, state.zoom / 1.2); applyTransform();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    navigate(-1, /*manual*/ true);
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    navigate(+1, /*manual*/ true);
  } else if (e.key === ' ') {
    // Space: toggle slideshow. Only meaningful when there's >1 image.
    if (ctx.siblings.length > 1) {
      e.preventDefault();
      toggleSlideshow();
    }
  } else if (e.key === '[') {
    adjustSlideshowSpeed(2);   // longer interval = slower
  } else if (e.key === ']') {
    adjustSlideshowSpeed(0.5); // shorter interval = faster
  }
});

// --- Neighbor prefetch ---
// Warm the previous/next sibling into the browser image cache (and pre-decode
// them) so ←/→ and slideshow swaps paint instantly instead of waiting on a
// cold fetch+decode. Keyed by webview URI. fileUpdate cache-busted URIs
// (…?v=N) never land here: they only ever apply to the *current* image, while
// neighbors are always read from ctx.siblings, which holds the plain URIs.
const prefetchCache = new Map<string, HTMLImageElement>();

// True once the user has actually moved within THIS webview (←/→ or
// slideshow). Explorer-click usage opens a fresh webview per image and never
// navigates inside it — kicking background TIFF/HEIC pre-decodes there (each
// booting its own WASM instance per webview) is pure waste, and made
// unrelated JPG opens feel sluggish in mixed folders.
let hasNavigatedThisView = false;

function schedulePrefetch(): void {
  if (ctx.siblings.length <= 1) return;
  const n = ctx.siblings.length;
  const cur = state.currentIndex;
  const wantedNative: string[] = [];
  // Decoder neighbors carry their direction so we can attempt +1 before -1 —
  // forward browsing / slideshow then wins the (budget-limited) decode slot.
  const decoderNeighbors: Array<{ uri: string; name: string; dir: number }> = [];
  for (const dir of [-1, 1] as const) {
    let idx = cur + dir;
    if (idx < 0) idx = ctx.browseLoop ? n - 1 : -1;
    else if (idx >= n) idx = ctx.browseLoop ? 0 : -1;
    if (idx < 0 || idx === cur) continue;   // out of range (no loop) or wrapped onto self
    const sib = ctx.siblings[idx];
    if (!sib) continue;
    if (isTiffName(sib.name) || isHeicName(sib.name)) {
      // TIFF/HEIC can't warm through a plain Image() — they get a background
      // pre-decode into decodedCache below instead.
      decoderNeighbors.push({ uri: sib.uri, name: sib.name, dir });
      continue;
    }
    wantedNative.push(sib.uri);
    if (!prefetchCache.has(sib.uri)) {
      const im = new Image();
      im.decoding = 'async';
      im.src = sib.uri;
      // Pre-decode off the main thread; ignore failures (broken/aborted file).
      im.decode?.().catch(() => {});
      prefetchCache.set(sib.uri, im);
    }
  }
  // Evict native entries that are no longer an immediate neighbor. Plain delete
  // is enough — these are webview-resource URIs, not blob: URLs, so there's no
  // object URL to revoke.
  for (const key of prefetchCache.keys()) {
    if (!wantedNative.includes(key)) prefetchCache.delete(key);
  }

  // Decoded (TIFF/HEIC) neighbors: prune non-wanted first (frees a slot the
  // current image or a neighbor can reuse), then top up within budget — but
  // only once the user has navigated in this webview, or when the current
  // image itself is a decoder format (browsing/slideshow through HEICs
  // should start warm immediately).
  pruneDecodedCache();
  const decodePrefetchActive = hasNavigatedThisView ||
    isTiffName(state.filename) || isHeicName(state.filename);
  if (!decodePrefetchActive) return;
  decoderNeighbors.sort((a, b) => b.dir - a.dir);   // +1 (next) before -1 (prev)
  for (const nb of decoderNeighbors) {
    if (decodedCache.has(nb.uri)) continue;
    if (decodedCache.size >= DECODED_MAX_ENTRIES) break;   // no room
    // Busted `?v=` URIs only ever apply to the current image, never a
    // neighbor — but guard anyway so a pre-decode never fires against one.
    if (isBustedUri(nb.uri)) continue;
    const client = decoderClientFor(nb.name);
    if (!client) continue;
    // Never start a prefetch decode while a decode is already in flight on
    // this worker — a background pre-decode must not front-run a foreground
    // open. If a foreground swap arrives AFTER we've started, it rides our
    // in-flight promise via inflightDecodes instead of double-decoding.
    if (client.busy > 0) continue;
    void prefetchDecode(client, nb.uri);
  }
}

// Background pre-decode of a TIFF/HEIC neighbor into decodedCache. Budget is
// re-checked post-decode (the real pixel count is only known then) and again
// after the async bitmap build, so a race with a foreground present can't push
// the cache past its caps. Failures are swallowed like native prefetch misses.
async function prefetchDecode(client: DecodeWorkerClient, uri: string): Promise<void> {
  if (inflightDecodes.has(uri)) return;
  const job = doPrefetchDecode(client, uri);
  inflightDecodes.set(uri, job);
  try { await job; } finally { inflightDecodes.delete(uri); }
}

async function doPrefetchDecode(client: DecodeWorkerClient, uri: string): Promise<void> {
  try {
    const res = await fetch(uri);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const decoded = await client.decode(buf);
    if (decodedCache.has(uri)) return;                        // raced a foreground present
    const area = decoded.width * decoded.height;
    // Don't even build the bitmap if it can't be cached.
    if (area > DECODED_MAX_PIXELS) return;                    // oversized: never cache
    if (decodedCache.size >= DECODED_MAX_ENTRIES) return;
    if (decodedPixelTotal() + area > DECODED_MAX_PIXELS) return;
    const pixels = toClamped(decoded.rgba);
    const bitmap = await createImageBitmap(new ImageData(pixels, decoded.width, decoded.height));
    // Post-await recheck — a foreground decode may have filled a slot meanwhile.
    if (decodedCache.has(uri) ||
        decodedCache.size >= DECODED_MAX_ENTRIES ||
        decodedPixelTotal() + area > DECODED_MAX_PIXELS) {
      bitmap.close();
      return;
    }
    decodedCache.set(uri, { bitmap, w: decoded.width, h: decoded.height, hasAlpha: decoded.hasAlpha });
  } catch {
    // Broken / aborted neighbor — ignore, exactly like a native prefetch failure.
  }
}

// --- Browse / slideshow ---

let slideshowTimer: number | null = null;

function navigate(direction: -1 | 1, manual: boolean): void {
  if (ctx.siblings.length <= 1) return;
  let idx = state.currentIndex + direction;
  if (idx < 0) idx = ctx.browseLoop ? ctx.siblings.length - 1 : 0;
  else if (idx >= ctx.siblings.length) idx = ctx.browseLoop ? 0 : ctx.siblings.length - 1;
  if (idx === state.currentIndex) {
    // Hit a non-loop boundary. If slideshow is running, stop it cleanly so
    // the user notices we ran out instead of silently sitting on the last
    // image.
    if (state.slideshowOn && !manual) stopSlideshow();
    return;
  }
  swapTo(idx);
}

function swapTo(idx: number): void {
  const sib = ctx.siblings[idx];
  if (!sib) return;
  hasNavigatedThisView = true;
  state.currentIndex = idx;
  state.filename = sib.name;
  state.fileSize = sib.size;
  state.mtime = sib.mtime;
  state.currentUri = sib.uri;
  // New image: reset transform — keeping zoom across different aspect
  // ratios feels random. Pan/zoom is per-image intent.
  state.zoom = 1; state.panX = 0; state.panY = 0;
  // Forget the old natural size so applyTransform doesn't briefly size
  // the new image as if it had the previous image's dimensions.
  state.natural.w = 0; state.natural.h = 0;
  // Clear stale EXIF immediately so the previous image's data doesn't flash
  // through the next render() before exif reload finishes.
  state.exif = null;
  // Same for alpha — the file card's RGB/RGBA line is derived from
  // state.hasAlpha, so drop it too or the previous image's channel count
  // flashes until the settle pass recomputes it (or the decoder sets it).
  state.hasAlpha = null;
  // loadImageInto bumps state.loadGen and wires the load handler with the
  // race-safe gen check; works for both regular images and TIFF.
  loadImageInto(sib.uri, sib.name);
  applyTransform();
  render();
}

function toggleSlideshow(): void {
  if (state.slideshowOn) stopSlideshow();
  else startSlideshow();
}

function startSlideshow(): void {
  if (ctx.siblings.length <= 1) return;
  state.slideshowOn = true;
  scheduleSlideshowTick();
  render();
}

function stopSlideshow(): void {
  state.slideshowOn = false;
  if (slideshowTimer != null) {
    clearTimeout(slideshowTimer);
    slideshowTimer = null;
  }
  render();
}

function scheduleSlideshowTick(): void {
  // Always clear any pending timer first, so every scheduling path (first
  // tick, per-image settle, speed change, a manual ←/→ that lands its own
  // settle) collapses to a single live timer — no parallel chains.
  if (slideshowTimer != null) clearTimeout(slideshowTimer);
  slideshowTimer = window.setTimeout(() => {
    if (!state.slideshowOn) return;
    // Advance one image and stop — deliberately NOT self-rescheduling. The
    // next tick is armed from wherever this swap settles (settleImage after
    // its gen check, or a decode/error handler for a broken file), so an
    // interval shorter than decode time can't skip past images that never
    // actually displayed.
    navigate(+1, /*manual*/ false);
  }, state.slideshowIntervalMs);
}

function adjustSlideshowSpeed(factor: number): void {
  const next = Math.max(SLIDESHOW_MIN_MS, Math.min(SLIDESHOW_MAX_MS,
    Math.round(state.slideshowIntervalMs * factor)));
  if (next === state.slideshowIntervalMs) return;
  state.slideshowIntervalMs = next;
  // If running, restart the timer so the new interval takes effect from now,
  // not from whenever the previous tick was scheduled.
  if (state.slideshowOn) scheduleSlideshowTick();
  // Update the BR indicator immediately even when paused, so the user sees
  // the new value before they hit play.
  updateZoomDisplay();
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === 'toggleOverlay') {
    state.visible = !state.visible;
    render();
  } else if (msg.type === 'toggleExpanded') {
    state.expanded = !state.expanded;
    render();
  } else if (msg.type === 'fileUpdate') {
    // Disk-write notification for the originally-opened image. If the user
    // has navigated away to a sibling, this is stale — ignore it (we'd be
    // overwriting the wrong file's metadata).
    if (state.currentIndex !== ctx.currentIndex) return;
    state.fileSize = msg.fileSize;
    state.mtime = msg.mtime;
    const bust = `${ctx.imageUri}${ctx.imageUri.includes('?') ? '&' : '?'}v=${msg.cacheBust}`;
    // The file changed on disk — a decoded bitmap cached under the plain URI
    // would repaint the PRE-edit pixels on the next navigate-back. Evict it
    // (busted URIs themselves never enter the cache).
    evictDecoded(ctx.imageUri);
    evictDecoded(state.currentUri);
    state.currentUri = bust;
    state.exif = null;
    loadImageInto(bust, state.filename);
  } else if (msg.type === 'siblings') {
    // The host enumerates the folder off the render path and delivers the
    // sorted/filtered sibling list here, at most once. Update state.currentIndex
    // and ctx.currentIndex together: navigation is impossible while ctx.siblings
    // is empty, so they can't diverge before this point, and moving both in
    // lockstep keeps the fileUpdate staleness check
    // (state.currentIndex !== ctx.currentIndex) valid — it only ever becomes
    // true once the user actually navigates away, exactly as before.
    ctx.siblings = msg.siblings;
    ctx.currentIndex = msg.currentIndex;
    state.currentIndex = msg.currentIndex;
    render();             // the "N / M" position counter now has data to show
    schedulePrefetch();   // and the immediate neighbors can start warming
  }
});

if (!ctx.showHint) {
  hint.style.display = 'none';
} else {
  setTimeout(() => hint.classList.add('fade'), 6000);
}

// --- A: idle auto-fade ---
const IDLE_MS = 2500;
let lastActivity = performance.now();

function markActive() {
  lastActivity = performance.now();
  if (document.body.classList.contains('idle')) {
    document.body.classList.remove('idle');
  }
}

window.addEventListener('mousemove', (e) => {
  markActive();
  lastCursor.x = e.clientX;
  lastCursor.y = e.clientY;
  scheduleProximityUpdate();
});
window.addEventListener('keydown', markActive);
window.addEventListener('wheel', markActive, { passive: true });
window.addEventListener('mousedown', markActive);
window.addEventListener('focus', markActive);
window.addEventListener('blur', () => {
  // reset so returning to the tab doesn't immediately flag idle
  lastActivity = performance.now();
});

setInterval(() => {
  if (!document.hasFocus()) return;
  if (performance.now() - lastActivity > IDLE_MS) {
    document.body.classList.add('idle');
  }
}, 400);

// --- C: corner-local proximity fade ---
// Distance is measured from the cursor to the actual rendered overlay
// rectangle (with a small buffer), not from a fixed viewport corner. This
// matters when the TL slot expands to the EXIF table — the old fixed-radius
// check kept fading the small original footprint and ignored the new size.
const FADE_BUFFER_PX = 48;

function updateCornerProximity(x: number, y: number) {
  (Object.keys(overlays) as CornerKey[]).forEach((key) => {
    const node = overlays[key];
    if (node.classList.contains('empty')) {
      node.classList.remove('cursor-near');
      return;
    }
    const r = node.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) {
      node.classList.remove('cursor-near');
      return;
    }
    // Distance from a point to an axis-aligned rectangle: clamp to 0 inside.
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = Math.hypot(dx, dy);
    node.classList.toggle('cursor-near', d < FADE_BUFFER_PX);
  });
}

function refreshProximity() {
  if (lastCursor.x >= 0) updateCornerProximity(lastCursor.x, lastCursor.y);
}
