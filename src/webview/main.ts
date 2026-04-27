import exifr from 'exifr';

interface InjectedCtx {
  filename: string;
  fileSize: number;
  mtime: number;
  imageUri: string;
  defaultVisible: boolean;
  autoContrast: boolean;
  showHint: boolean;
  gpsMapProvider: 'openstreetmap' | 'google' | 'apple' | 'none';
}

const ctx = (window as unknown as { __IMG_CTX__: InjectedCtx }).__IMG_CTX__;

const img = document.getElementById('img') as HTMLImageElement;
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
  fileSize: ctx.fileSize,
  mtime: ctx.mtime,
  hasAlpha: null as boolean | null,
};

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
  const ext = getExt(ctx.filename);
  const lines: string[] = [];
  lines.push(`<div class="title" title="${escapeHtml(ctx.filename)}">${escapeHtml(ctx.filename)}</div>`);
  if (w && h) {
    const mp = (w * h / 1e6).toFixed(1);
    const ratio = gcdRatio(w, h);
    lines.push(`<div class="meta big">${w} × ${h}</div>`);
    lines.push(`<div class="meta dim">${ext}${ext ? ' · ' : ''}${fmtSize(state.fileSize)} · ${mp} MP${ratio ? ' · ' + ratio : ''}</div>`);
  } else {
    lines.push(`<div class="meta dim">${ext}${ext ? ' · ' : ''}${fmtSize(state.fileSize)}</div>`);
  }

  const colorMode = describeColorMode(e);
  if (colorMode) lines.push(`<div class="meta dim">${escapeHtml(colorMode)}</div>`);

  const artist = pick<string>(e, 'Artist', 'Creator');
  const copyright = pick<string>(e, 'Copyright', 'Rights');
  const attribution = [
    copyright ? `© ${escapeHtml(String(copyright))}` : '',
    artist && !copyright ? escapeHtml(String(artist)) : '',
  ].filter(Boolean).join(' · ');
  if (attribution) lines.push(`<div class="meta dim">${attribution}</div>`);

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
    <div class="title" title="${escapeHtml(ctx.filename)}">${escapeHtml(ctx.filename)}</div>
    <div class="meta dim">${getExt(ctx.filename)} · ${fmtSize(state.fileSize)} · ${state.natural.w}×${state.natural.h}${colorMode ? ' · ' + escapeHtml(colorMode) : ''}</div>
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
  try {
    const res = await fetch(uri);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const buf = await res.arrayBuffer();
    state.exif = await exifr.parse(buf, {
      tiff: true,
      xmp: true,
      iptc: true,
      icc: false,
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
  const ext = getExt(ctx.filename).toLowerCase();
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
  img.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  updateZoomDisplay();
}

async function onImageReady(): Promise<void> {
  state.natural.w = img.naturalWidth;
  state.natural.h = img.naturalHeight;
  await analyzeCorners();
  detectAlpha();
  render();
  await loadExif(state.currentUri);
  render();
}

if (img.complete && img.naturalWidth > 0) {
  void onImageReady();
} else {
  img.addEventListener('load', () => void onImageReady(), { once: true });
}

img.addEventListener('error', () => {
  overlays.tl.innerHTML = `
    <div class="title">${escapeHtml(ctx.filename)}</div>
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
  } else if (e.key === '0') {
    state.zoom = 1; state.panX = 0; state.panY = 0;
    applyTransform();
  } else if (e.key === '+' || e.key === '=') {
    state.zoom = Math.min(32, state.zoom * 1.2); applyTransform();
  } else if (e.key === '-' || e.key === '_') {
    state.zoom = Math.max(0.05, state.zoom / 1.2); applyTransform();
  }
});

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
    state.fileSize = msg.fileSize;
    state.mtime = msg.mtime;
    const bust = `${ctx.imageUri}${ctx.imageUri.includes('?') ? '&' : '?'}v=${msg.cacheBust}`;
    state.currentUri = bust;
    img.src = bust;
    state.exif = null;
    img.addEventListener('load', () => void onImageReady(), { once: true });
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
