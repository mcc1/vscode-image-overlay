import exifr from 'exifr';
// TIFF decoder. utif is CJS but esbuild handles interop; the namespace
// import gives us the decode / decodeImage / toRGBA8 functions we need.
import * as UTIF from 'utif';

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
}

const ctx = (window as unknown as { __IMG_CTX__: InjectedCtx }).__IMG_CTX__;

// Webview → host channel (used to keep session-scoped UI flags like the
// histogram toggle in sync across separate webviews of the same provider).
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
const vscodeApi = acquireVsCodeApi();

const img = document.getElementById('img') as HTMLImageElement;
// Zoom/pan transforms live on the wrapper, not on the <img> itself —
// keeping <img> off the transform tree dodges Chromium's GPU-compositor
// tile-seam bug that draws 1px black lines across large scaled images.
// See media/viewer.css for the matching #img-wrap rules.
const imgWrap = document.getElementById('img-wrap') as HTMLDivElement;
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
  // this, fast ←/→ presses can race and call onImageReady() out of order.
  loadGen: 0,
  // For TIFF: <img> can't render TIFF natively, so we decode via utif into
  // a PNG blob and point img at that. Track the URL so we can revoke it
  // on the next swap (otherwise blob URLs accumulate in memory).
  currentBlobUrl: null as string | null,
  // True between "we know this is TIFF/HEIC" and "the decoded blob has
  // loaded into <img>". The error handler uses these (alongside is*Name)
  // to suppress the inline-load error event the browser fires on the
  // original unsupported bytes.
  tiffDecoding: false,
  heicDecoding: false,
};

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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtExposure(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return '';
  if (v >= 1) return `${v}s`;
  return `1/${Math.round(1 / v)}s`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function formatMaybeDate(v: unknown): string {
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toLocaleString();
  return '';
}

function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toUpperCase();
}

function gcdRatio(a: number, b: number): string {
  if (!a || !b) return '';
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const d = gcd(a, b);
  return `${a / d}:${b / d}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function mapUrl(lat: number, lon: number): string | null {
  switch (ctx.gpsMapProvider) {
    case 'google':
      return `https://www.google.com/maps?q=${lat},${lon}`;
    case 'apple':
      return `https://maps.apple.com/?q=${lat},${lon}&ll=${lat},${lon}`;
    case 'openstreetmap':
      return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`;
    case 'none':
    default:
      return null;
  }
}

interface MapTile { url: string; left: number; top: number; }
interface MapView { tiles: MapTile[]; width: number; height: number; }

function computeMapView(lat: number, lon: number, zoom: number, w: number, h: number): MapView {
  const n = Math.pow(2, zoom);
  const xFrac = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const yFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  const worldX = xFrac * 256;
  const worldY = yFrac * 256;
  const viewLeft = worldX - w / 2;
  const viewTop = worldY - h / 2;
  const tx0 = Math.floor(viewLeft / 256);
  const tx1 = Math.floor((viewLeft + w - 1) / 256);
  const ty0 = Math.floor(viewTop / 256);
  const ty1 = Math.floor((viewTop + h - 1) / 256);
  const tiles: MapTile[] = [];
  const maxTile = n;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0 || tx >= maxTile || ty >= maxTile) continue;
      tiles.push({
        url: `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`,
        left: tx * 256 - viewLeft,
        top: ty * 256 - viewTop,
      });
    }
  }
  return { tiles, width: w, height: h };
}

function renderMapThumb(lat: number, lon: number, linkUrl: string | null, label: string): string {
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
    ? `<a class="map-link" href="${escapeAttr(linkUrl)}" title="Open in map">${body}</a>`
    : `<div class="map-link static">${body}</div>`;
}

// Best-effort color-space detection. ICC profile description is the most
// trustworthy signal — Apple iPhones tag JPEGs as ColorSpace=Uncalibrated
// in EXIF and put the actual "Display P3" in the ICC profile. Falls back
// to the EXIF ColorSpace tag for older / sRGB images.
function describeColorSpace(e: Record<string, unknown> | null): string {
  if (!e) return '';
  const profileDesc = pick<string>(e, 'ProfileDescription');
  if (profileDesc) {
    const m = String(profileDesc).match(
      /^(sRGB|Display P3|Adobe RGB|ProPhoto RGB|DCI-P3|Rec\.?\s*\d+)/i,
    );
    return m ? m[1] : profileDesc;
  }
  const cs = e.ColorSpace;
  if (cs === 1 || cs === 'sRGB') return 'sRGB';
  if (cs === 2 || cs === 'Adobe RGB' || cs === 'AdobeRGB') return 'Adobe RGB';
  return '';
}

// HDR detection — covers the cases exifr can surface today:
//  - UltraHDR / Adobe gain map JPEG: XMP namespace `hdrgm:` (ISO 21496)
//  - Apple Adaptive HDR JPEG: XMP `apple:HDREncoding` or `AppleHDREncoding`
// AVIF / HEIC HDR (transfer = HLG/PQ in nclx box) and HDR PNG (cICP) need
// raw box parsing we don't do yet, so HDR JPEGs from Pixel / iPhone / Galaxy
// are the main coverage now.
function detectHdr(e: Record<string, unknown> | null): string {
  if (!e) return '';
  if (pick(e, 'hdrgm:Version', 'hdrgmVersion', 'HDRGain') != null) return 'UltraHDR';
  const appleHdr = pick(e, 'AppleHDREncoding', 'apple:HDREncoding');
  if (appleHdr === true || appleHdr === 'true' || appleHdr === 1) return 'Apple HDR';
  return '';
}

function describeColorMode(e: Record<string, unknown> | null): string {
  // PNG IHDR colorType: 0=grayscale, 2=RGB, 3=palette, 4=grayscale+alpha, 6=RGB+alpha
  const colorType = e?.ColorType as number | undefined;
  const bits = pick<number>(e, 'BitDepth', 'BitsPerSample');
  const parts: string[] = [];
  if (typeof bits === 'number') parts.push(`${bits}-bit`);

  if (typeof colorType === 'number') {
    const ct = colorType === 0 ? 'Gray'
      : colorType === 2 ? 'RGB'
      : colorType === 3 ? 'Indexed'
      : colorType === 4 ? 'Gray+A'
      : colorType === 6 ? 'RGBA'
      : '';
    if (ct) parts.push(ct);
  } else if (state.hasAlpha != null) {
    parts.push(state.hasAlpha ? 'RGBA' : 'RGB');
  }
  return parts.join(' ');
}

function describeCaptureExtras(e: Record<string, unknown>): string[] {
  const lines: string[] = [];

  // White balance — only show when non-Auto
  const wb = pick<string | number>(e, 'WhiteBalance');
  const wbStr = typeof wb === 'string' ? wb : wb === 1 ? 'Manual WB' : '';
  // Flash — only when fired / meaningful
  const flash = pick<string | number>(e, 'Flash');
  const flashStr = typeof flash === 'string'
    ? (flash.toLowerCase().includes('no flash') ? '' : flash)
    : typeof flash === 'number' && flash & 1 ? 'Flash fired' : '';
  // Metering
  const metering = pick<string>(e, 'MeteringMode');
  const meteringStr = typeof metering === 'string' && metering !== 'Unknown' ? metering : '';
  // Exposure compensation
  const evc = pick<number>(e, 'ExposureBiasValue', 'ExposureCompensation');
  const evcStr = typeof evc === 'number' && evc !== 0 ? `${evc > 0 ? '+' : ''}${evc} EV` : '';

  const extras = [wbStr, flashStr, meteringStr, evcStr].filter(Boolean);
  if (extras.length) lines.push(extras.join(' · '));
  return lines;
}

function pick<T = unknown>(obj: Record<string, unknown> | null, ...keys: string[]): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k] as T;
  }
  return undefined;
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

  const colorMode = describeColorMode(e);
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
  if (shot) lines.push(`<div class="meta">${shot}</div>`);

  for (const line of describeCaptureExtras(e)) {
    lines.push(`<div class="meta dim">${line}</div>`);
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
  const gpsUrl = mapUrl(lat, lon);
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

function setOverlay(key: CornerKey, html: string) {
  const node = overlays[key];
  if (html) {
    node.innerHTML = html;
    node.classList.remove('empty');
  } else {
    node.innerHTML = '';
    node.classList.add('empty');
  }
}

function render() {
  document.body.classList.toggle('overlay-hidden', !state.visible);
  document.body.classList.toggle('expanded', state.expanded);

  if (state.expanded) {
    // Expanded mode replaces the TL capture card with the full EXIF table.
    // BL/TR stay empty so the table has room to grow; BR keeps zoom % so the
    // user still has a zoom indicator while inspecting EXIF.
    renderExpanded();
    setOverlay('bl', '');
    setOverlay('tr', '');
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
      keys: ['Orientation', 'ColorSpace', 'BitDepth', 'ColorType', 'BitsPerSample',
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
  const gpsUrl = typeof lat === 'number' && typeof lon === 'number' ? mapUrl(lat, lon) : null;

  const renderedSections: string[] = [];
  for (const section of sections) {
    const rows: string[] = [];
    for (const k of section.keys) {
      const v = e[k];
      if (v == null || v === '') continue;
      let display = v instanceof Date ? v.toLocaleString() : String(v);
      // hyperlink GPS coords in the expanded table too
      if ((k === 'latitude' || k === 'longitude') && gpsUrl) {
        display = `<a href="${escapeAttr(gpsUrl)}" class="gps-link">${escapeHtml(display)}</a>`;
      } else {
        display = escapeHtml(display);
      }
      rows.push(`<tr><td>${escapeHtml(k)}</td><td>${display}</td></tr>`);
    }
    if (rows.length) {
      renderedSections.push(
        `<div class="exif-section"><div class="exif-section-title">${section.title}</div>` +
        `<table class="exif-table">${rows.join('')}</table></div>`
      );
    }
  }

  const colorMode = describeColorMode(e);
  const header = `
    <div class="title" title="${escapeHtml(state.filename)}">${escapeHtml(state.filename)}</div>
    <div class="meta dim">${getExt(state.filename)} · ${fmtSize(state.fileSize)} · ${state.natural.w}×${state.natural.h}${colorMode ? ' · ' + escapeHtml(colorMode) : ''}</div>
  `;

  overlays[target].innerHTML = header + (renderedSections.length
    ? renderedSections.join('')
    : `<div class="meta dim" style="margin-top:8px">no EXIF data</div>`);
  overlays[target].classList.remove('empty');
}

async function analyzeCorners(): Promise<void> {
  try {
    const size = 200;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const cctx = canvas.getContext('2d');
    if (!cctx) return;
    cctx.drawImage(img, 0, 0, size, size);
    const rs = 56;
    const regions: Array<{ key: CornerKey; x: number; y: number }> = [
      { key: 'tl', x: 0, y: 0 },
      { key: 'tr', x: size - rs, y: 0 },
      { key: 'bl', x: 0, y: size - rs },
      { key: 'br', x: size - rs, y: size - rs },
    ];
    // Per-corner luminance only — used to pick on-dark vs on-light glass tint.
    // No more ranking: slot assignment is fixed (see FIXED_LAYOUT comment).
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
  } catch (err) {
    console.warn('[image-overlay] corner analysis failed', err);
  }
}

async function loadExif(uri: string): Promise<void> {
  // Hand the URI directly to exifr instead of pre-fetching the whole file
  // into an ArrayBuffer. exifr's default chunked mode (true for URL input
  // in browser) issues Range requests and only pulls the few segments it
  // needs — a 100 MB image now reads ~64 KB instead of allocating 100 MB
  // on the main thread. Falls back to a full fetch automatically if the
  // underlying transport doesn't honor Range, so no behavioral regression
  // on hosts that don't.
  try {
    state.exif = await exifr.parse(uri, {
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
    state.exif = null;
  }
}

function detectAlpha(): void {
  // Skip formats that can't have alpha
  const ext = getExt(state.filename).toLowerCase();
  if (['jpg', 'jpeg', 'bmp'].includes(ext)) {
    state.hasAlpha = false;
    return;
  }
  try {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const cctx = canvas.getContext('2d');
    if (!cctx) return;
    // Fill with a sentinel color so we can distinguish transparent from the default
    cctx.drawImage(img, 0, 0, size, size);
    const data = cctx.getImageData(0, 0, size, size).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) {
        state.hasAlpha = true;
        return;
      }
    }
    state.hasAlpha = false;
  } catch {
    state.hasAlpha = null;
  }
}

function applyTransform() {
  // Pan is a translate on the wrapper — translate never GPU-tiles. Zoom
  // is applied as explicit pixel width/height on the <img>; the browser
  // rasterizes at the actual display size so the compositor never scales
  // a tiled bitmap (which is what produced the 1px tile-seam lines on
  // large photos at non-integer scales).
  imgWrap.style.transform = `translate(${state.panX}px, ${state.panY}px)`;

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
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.width = `${state.natural.w * display}px`;
    img.style.height = `${state.natural.h * display}px`;
  } else {
    // No natural dims yet — let CSS max-width/max-height handle it.
    img.style.width = '';
    img.style.height = '';
    img.style.maxWidth = '';
    img.style.maxHeight = '';
  }

  updateZoomDisplay();
}

// --- TIFF rendering ---
// Chromium can't decode TIFF in <img>. We catch .tif/.tiff at load time and
// route through utif: fetch bytes → decode IFD → toRGBA8 → canvas → PNG
// blob URL → set img.src. Everything downstream (corners, EXIF, histogram)
// keeps working because they all read from the live <img>.

function isTiffName(name: string): boolean {
  const ext = getExt(name).toLowerCase();
  return ext === 'tif' || ext === 'tiff';
}

function isHeicName(name: string): boolean {
  const ext = getExt(name).toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

// Webview can't render HEIC natively (Chromium drops the format on most
// platforms). We dispatch to a libheif-js Web Worker — built as its own
// 1.4 MB bundle and lazy-fetched the first time a HEIC opens. The decoded
// RGBA comes back over a Transferable so we don't pay for a 100 MB copy.

// VS Code webview-resources sit on a different origin from the webview
// itself, and `new Worker(url)` enforces same-origin. Workaround: fetch
// the worker bundle, wrap it in a Blob, and spawn from the resulting
// blob URL — blob URLs inherit the page origin, so same-origin passes.
// Cached after first use so we don't re-fetch the 1.4 MB on every HEIC.
let heicWorkerBlobUrl: string | null = null;
async function getHeicWorkerBlobUrl(): Promise<string> {
  if (heicWorkerBlobUrl) return heicWorkerBlobUrl;
  const res = await fetch(ctx.heicWorkerUri);
  if (!res.ok) throw new Error(`worker fetch ${res.status}`);
  const src = await res.text();
  const blob = new Blob([src], { type: 'application/javascript' });
  heicWorkerBlobUrl = URL.createObjectURL(blob);
  return heicWorkerBlobUrl;
}

async function decodeHeicToBlobUrl(uri: string): Promise<string> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await res.arrayBuffer();

  const workerUrl = await getHeicWorkerBlobUrl();
  const worker = new Worker(workerUrl);
  let result: { rgba: Uint8ClampedArray; width: number; height: number };
  try {
    result = await new Promise<typeof result>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = e.data as
          | { ok: true; rgba: Uint8ClampedArray; width: number; height: number; hasAlpha: boolean }
          | { ok: false; error: string };
        if (!d.ok) { reject(new Error(d.error)); return; }
        resolve({ rgba: d.rgba, width: d.width, height: d.height });
      };
      worker.onerror = (ev: ErrorEvent) => {
        // ErrorEvent fields are sparse for cross-origin / WASM failures.
        // Concatenate what we have so the UI shows something useful.
        const detail =
          ev.message ||
          (ev.filename ? `${ev.filename}:${ev.lineno || '?'}` : '') ||
          'worker error';
        reject(new Error(detail));
      };
      worker.postMessage({ buffer: buf }, [buf]);
    });
  } finally {
    worker.terminate();
  }

  const canvas = document.createElement('canvas');
  canvas.width = result.width;
  canvas.height = result.height;
  const cctx = canvas.getContext('2d');
  if (!cctx) throw new Error('no canvas 2d ctx');
  // Same ArrayBufferLike → ArrayBuffer cast as the TIFF path: the rgba
  // came from libheif which allocates a regular ArrayBuffer.
  const clamped = new Uint8ClampedArray(
    result.rgba.buffer as ArrayBuffer,
    result.rgba.byteOffset,
    result.rgba.byteLength,
  );
  cctx.putImageData(new ImageData(clamped, result.width, result.height), 0, 0);
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

async function decodeTiffToBlobUrl(uri: string): Promise<string> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error('no IFDs in TIFF');
  const ifd = ifds[0];
  UTIF.decodeImage(buf, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  const w = ifd.width;
  const h = ifd.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const cctx = canvas.getContext('2d');
  if (!cctx) throw new Error('no canvas 2d ctx');
  // The ArrayBufferLike → ArrayBuffer cast is safe: rgba came out of utif
  // which allocates a regular ArrayBuffer (not SharedArrayBuffer). Going
  // through the buffer + byteOffset slot avoids copying the full RGBA
  // array (~4 × W × H bytes — easily 100 MB on a 24 MP file).
  const clamped = new Uint8ClampedArray(
    rgba.buffer as ArrayBuffer,
    rgba.byteOffset,
    rgba.byteLength,
  );
  cctx.putImageData(new ImageData(clamped, w, h), 0, 0);
  // toBlob is async; resolve with the object URL.
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

function freeCurrentBlobUrl(): void {
  if (state.currentBlobUrl) {
    URL.revokeObjectURL(state.currentBlobUrl);
    state.currentBlobUrl = null;
  }
}

// Unified image loader. For most formats the URI goes straight to img.src;
// for TIFF and HEIC we run a decode pipeline first that produces a PNG
// blob URL. Either way, onImageReady fires once the image is actually
// ready in <img> (load event) — this single entry point lets nav,
// fileUpdate and the initial load share the gen-token race-handling.
function loadImageInto(uri: string, name: string): void {
  state.loadGen += 1;
  const myGen = state.loadGen;

  const onLoad = () => {
    if (myGen !== state.loadGen) return;
    state.tiffDecoding = false;
    state.heicDecoding = false;
    void onImageReady();
  };
  img.addEventListener('load', onLoad, { once: true });

  // Pick a decoder for formats <img> can't render natively.
  let decode: ((u: string) => Promise<string>) | null = null;
  let label = '';
  if (isTiffName(name)) {
    state.tiffDecoding = true;
    decode = decodeTiffToBlobUrl;
    label = 'TIFF';
  } else if (isHeicName(name)) {
    state.heicDecoding = true;
    decode = decodeHeicToBlobUrl;
    label = 'HEIC';
  }

  if (decode) {
    // Stop the browser from chewing on the unsupported bytes — the inline
    // src in the HTML triggers a load attempt the moment the page parses,
    // and if we let it finish we'd get a flash of "failed to load" before
    // the decoded blob takes over.
    img.removeAttribute('src');
    decode(uri).then((blobUrl) => {
      if (myGen !== state.loadGen) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      freeCurrentBlobUrl();
      state.currentBlobUrl = blobUrl;
      img.src = blobUrl;
    }).catch((err) => {
      if (myGen !== state.loadGen) return;
      console.warn(`[image-overlay] ${label} decode failed`, err);
      state.tiffDecoding = false;
      state.heicDecoding = false;
      const detail = err instanceof Error ? err.message : String(err);
      // Show the underlying error in the TL card too — without it the user
      // has no signal beyond "didn't work" and we can't act on bug reports.
      overlays.tl.innerHTML = `
        <div class="title">${escapeHtml(state.filename)}</div>
        <div class="meta dim">${label} decode failed</div>
        <div class="meta dim" style="font-size:10px;opacity:0.7;word-break:break-word;">${escapeHtml(detail)}</div>`;
      overlays.tl.classList.remove('empty');
    });
  } else {
    // Switching to a natively-renderable format — release any previous
    // decode blob URL so we don't leak.
    freeCurrentBlobUrl();
    img.src = uri;
  }
}

async function onImageReady(): Promise<void> {
  state.natural.w = img.naturalWidth;
  state.natural.h = img.naturalHeight;
  // Now that we know the image's natural dimensions, switch from CSS
  // max-width/max-height to explicit pixel sizing — that's what avoids
  // the GPU compositor tile-seam bug on big photos.
  applyTransform();
  await analyzeCorners();
  detectAlpha();
  render();
  await loadExif(state.currentUri);
  render();
  // If the histogram is currently enabled, re-scan for the new image.
  // Discards any in-flight scan via the generation token.
  if (histState.on) {
    void refreshHistogram();
  }
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
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;

  // --- Path A (preferred): createImageBitmap → Worker w/ OffscreenCanvas.
  // The bitmap is decoded asynchronously by the browser and transferred
  // (zero-copy) into the worker, which does drawImage + getImageData
  // entirely off-thread. Main thread sees only one cheap async hop.
  // Modern Chromium (and therefore VS Code's webview) supports both APIs;
  // the feature-checks here are belt-and-suspenders.
  if (typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined') {
    try {
      const bitmap = await createImageBitmap(img);
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
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const cctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!cctx) return null;
    cctx.drawImage(img, 0, 0);
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
// immediately. The actual scan happens later inside onImageReady once the
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

// Initial load. If we already opened a TIFF or HEIC the inline <img src=...>
// in the HTML kicked off a doomed load — re-route via the right decoder.
// For natively-supported formats, if the inline src already finished
// loading by the time JS runs, fast-path straight into onImageReady;
// otherwise wait for it.
if (isTiffName(state.filename) || isHeicName(state.filename)) {
  loadImageInto(state.currentUri, state.filename);
} else {
  state.loadGen += 1;
  const initGen = state.loadGen;
  if (img.complete && img.naturalWidth > 0) {
    void onImageReady();
  } else {
    img.addEventListener('load', () => {
      if (initGen !== state.loadGen) return;
      void onImageReady();
    }, { once: true });
  }
}

img.addEventListener('error', () => {
  // Suppress the inline-load error event that fires when the browser tries
  // to render TIFF / HEIC natively — we route those through their decoders
  // and report real failures from inside loadImageInto's catch.
  if (state.tiffDecoding || state.heicDecoding) return;
  if (isTiffName(state.filename) || isHeicName(state.filename)) return;
  overlays.tl.innerHTML = `
    <div class="title">${escapeHtml(state.filename)}</div>
    <div class="meta dim">failed to load preview</div>`;
  overlays.tl.classList.remove('empty');
});

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = -Math.sign(e.deltaY) * 0.12;
  state.zoom = Math.max(0.05, Math.min(32, state.zoom * (1 + delta)));
  applyTransform();
}, { passive: false });

let dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  state.dragging = true;
  dragStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
  stage.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!state.dragging) return;
  state.panX = dragStart.panX + (e.clientX - dragStart.x);
  state.panY = dragStart.panY + (e.clientY - dragStart.y);
  applyTransform();
});
window.addEventListener('mouseup', () => {
  if (!state.dragging) return;
  state.dragging = false;
  stage.classList.remove('dragging');
});

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
  if (slideshowTimer != null) clearTimeout(slideshowTimer);
  slideshowTimer = window.setTimeout(() => {
    if (!state.slideshowOn) return;
    navigate(+1, /*manual*/ false);
    if (state.slideshowOn) scheduleSlideshowTick();
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
    state.currentUri = bust;
    state.exif = null;
    loadImageInto(bust, state.filename);
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
  updateCornerProximity(e.clientX, e.clientY);
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
