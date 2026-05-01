// Pure helpers — formatting, EXIF/XMP interpretation, geo math. No DOM,
// no globals, no module-level side effects, so the test suite can import
// these without spinning up a webview.

export type GpsMapProvider = 'openstreetmap' | 'google' | 'apple' | 'none';

// ---------- Generic formatting ----------

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtExposure(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v) || v <= 0) return '';
  if (v >= 1) return `${v}s`;
  return `1/${Math.round(1 / v)}s`;
}

export function formatMaybeDate(v: unknown): string {
  if (v instanceof Date) return v.toLocaleString();
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return new Date(v).toLocaleString();
  return '';
}

export function getExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toUpperCase();
}

export function gcdRatio(a: number, b: number): string {
  if (!a || !b) return '';
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const d = gcd(a, b);
  return `${a / d}:${b / d}`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
export function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// ---------- Format detection (by extension) ----------

export function isTiffName(name: string): boolean {
  const ext = getExt(name).toLowerCase();
  return ext === 'tif' || ext === 'tiff';
}

export function isHeicName(name: string): boolean {
  const ext = getExt(name).toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

// ---------- EXIF object helpers ----------

export function pick<T = unknown>(
  obj: Record<string, unknown> | null,
  ...keys: string[]
): T | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k] as T;
  }
  return undefined;
}

// EXIF ColorSpace is an enum that exifr leaves as raw integers:
// 1 = sRGB, 2 = Adobe RGB, 65535 = Uncalibrated. Modern phones (Samsung
// HEIC, iPhone JPEG) almost always write 65535 because the actual color
// info lives in the HEIC nclx box / ICC profile, not EXIF.
export function formatExifColorSpace(v: unknown): string {
  const num = typeof v === 'number' ? v : Number(v);
  if (num === 1) return 'sRGB';
  if (num === 2) return 'Adobe RGB';
  if (num === 65535) return 'Uncalibrated';
  return String(v);
}

// Best-effort color-space detection for the file card. ICC profile
// description is the most trustworthy signal — Apple iPhones tag JPEGs as
// ColorSpace=Uncalibrated in EXIF and put the actual "Display P3" in the
// ICC profile. Falls back to the EXIF ColorSpace tag for older / sRGB
// images.
export function describeColorSpace(e: Record<string, unknown> | null): string {
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

// HDR detection. Three independent signals, in order of trust:
//   1. `__hdrFormat` — synthetic key written by the format-aware enrichment
//      pass when an AVIF/HEIC nclx or PNG cICP triple has transfer ∈ {16, 18}.
//      Authoritative when present because we read the codec's own bytes.
//   2. UltraHDR — XMP `hdrgm:Version` set by Google's UltraHDR JPEGs.
//   3. Apple HDR — XMP `apple:HDREncoding` set by recent iOS HEICs that
//      ALSO ship a gain map (independent of the nclx-only HDR10 path).
export function detectHdr(e: Record<string, unknown> | null): string {
  if (!e) return '';
  const fromFormat = pick<string>(e, '__hdrFormat');
  if (fromFormat) return fromFormat;
  if (pick(e, 'hdrgm:Version', 'hdrgmVersion', 'HDRGain') != null) return 'UltraHDR';
  const appleHdr = pick(e, 'AppleHDREncoding', 'apple:HDREncoding');
  if (appleHdr === true || appleHdr === 'true' || appleHdr === 1) return 'Apple HDR';
  return '';
}

// Color mode = bit depth + channels (e.g. "8-bit RGBA"). hasAlpha is
// taken explicitly (rather than read from a global) so this stays pure
// and testable. Pass null when not yet detected.
export function describeColorMode(
  e: Record<string, unknown> | null,
  hasAlpha: boolean | null = null,
): string {
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
  } else if (hasAlpha != null) {
    parts.push(hasAlpha ? 'RGBA' : 'RGB');
  }
  return parts.join(' ');
}

export function describeCaptureExtras(e: Record<string, unknown>): string[] {
  const lines: string[] = [];

  const wb = pick<string | number>(e, 'WhiteBalance');
  const wbStr =
    typeof wb === 'string' && wb.toLowerCase() !== 'auto' ? wb
    : wb === 1 ? 'Manual WB' : '';
  const flash = pick<string | number>(e, 'Flash');
  const flashStr = typeof flash === 'string'
    ? (flash.toLowerCase().includes('no flash') ? '' : flash)
    : typeof flash === 'number' && flash & 1 ? 'Flash fired' : '';
  const metering = pick<string>(e, 'MeteringMode');
  const meteringStr = typeof metering === 'string' && metering !== 'Unknown' ? metering : '';
  const evc = pick<number>(e, 'ExposureBiasValue', 'ExposureCompensation');
  const evcStr = typeof evc === 'number' && evc !== 0 ? `${evc > 0 ? '+' : ''}${evc} EV` : '';

  const extras = [wbStr, flashStr, meteringStr, evcStr].filter(Boolean);
  if (extras.length) lines.push(extras.join(' · '));
  return lines;
}

// ---------- Map URL + slippy-tile math ----------

export function mapUrl(lat: number, lon: number, provider: GpsMapProvider): string | null {
  switch (provider) {
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

export interface MapTile { url: string; left: number; top: number; }
export interface MapView { tiles: MapTile[]; width: number; height: number; }

export function computeMapView(
  lat: number,
  lon: number,
  zoom: number,
  w: number,
  h: number,
): MapView {
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
