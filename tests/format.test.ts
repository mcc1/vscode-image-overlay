import { describe, it, expect } from 'vitest';
import {
  fmtSize, fmtExposure, formatMaybeDate, getExt, gcdRatio,
  escapeHtml, escapeAttr,
  isTiffName, isHeicName,
  pick,
  formatExifColorSpace,
  describeColorSpace, detectHdr, describeColorMode, describeCaptureExtras,
  mapUrl, computeMapView,
} from '../src/webview/lib/format.js';

// ---------- Generic formatting ----------

describe('fmtSize', () => {
  it('uses bytes under 1 KB', () => {
    expect(fmtSize(0)).toBe('0 B');
    expect(fmtSize(1023)).toBe('1023 B');
  });
  it('switches to KB / MB / GB at the right thresholds', () => {
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(2.5 * 1024 * 1024)).toBe('2.50 MB');
    expect(fmtSize(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });
});

describe('fmtExposure', () => {
  it('formats sub-second times as "1/Ns"', () => {
    expect(fmtExposure(1 / 250)).toBe('1/250s');
    expect(fmtExposure(0.025018002)).toBe('1/40s'); // S23U sample
  });
  it('formats >= 1s as "Xs"', () => {
    expect(fmtExposure(1)).toBe('1s');
    expect(fmtExposure(2.5)).toBe('2.5s');
  });
  it('returns empty for invalid inputs', () => {
    expect(fmtExposure(0)).toBe('');
    expect(fmtExposure(-1)).toBe('');
    expect(fmtExposure(NaN)).toBe('');
    expect(fmtExposure('1/250')).toBe(''); // string not coerced
    expect(fmtExposure(null)).toBe('');
    expect(fmtExposure(undefined)).toBe('');
  });
});

describe('formatMaybeDate', () => {
  it('renders Date instances via toLocaleString', () => {
    const d = new Date('2024-06-15T12:00:00Z');
    expect(formatMaybeDate(d)).toBe(d.toLocaleString());
  });
  it('passes strings through', () => {
    expect(formatMaybeDate('2024:06:15 12:00:00')).toBe('2024:06:15 12:00:00');
  });
  it('treats numbers as epoch ms', () => {
    const ms = Date.now();
    expect(formatMaybeDate(ms)).toBe(new Date(ms).toLocaleString());
  });
  it('returns empty for unsupported types', () => {
    expect(formatMaybeDate(null)).toBe('');
    expect(formatMaybeDate(undefined)).toBe('');
    expect(formatMaybeDate({})).toBe('');
  });
});

describe('getExt', () => {
  it('returns the extension uppercased without the dot', () => {
    expect(getExt('photo.jpg')).toBe('JPG');
    expect(getExt('IMG_1234.HEIC')).toBe('HEIC');
    expect(getExt('archive.tar.gz')).toBe('GZ');
  });
  it('returns empty when there is no extension', () => {
    expect(getExt('README')).toBe('');
    expect(getExt('')).toBe('');
  });
});

describe('gcdRatio', () => {
  it('reduces common photo aspect ratios', () => {
    expect(gcdRatio(4032, 3024)).toBe('4:3');
    expect(gcdRatio(1920, 1080)).toBe('16:9');
    expect(gcdRatio(6000, 4000)).toBe('3:2');
    expect(gcdRatio(1000, 1000)).toBe('1:1');
  });
  it('returns empty for zero inputs', () => {
    expect(gcdRatio(0, 100)).toBe('');
    expect(gcdRatio(100, 0)).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes the five entity characters', () => {
    expect(escapeHtml('<a href="x">&\'')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
  it('leaves benign text alone', () => {
    expect(escapeHtml('hello, world!')).toBe('hello, world!');
  });
  it('escapeAttr is a thin alias', () => {
    expect(escapeAttr('"x"')).toBe(escapeHtml('"x"'));
  });
});

// ---------- Format detection ----------

describe('isTiffName / isHeicName', () => {
  it('matches both TIFF extensions case-insensitively', () => {
    expect(isTiffName('photo.tif')).toBe(true);
    expect(isTiffName('photo.TIFF')).toBe(true);
    expect(isTiffName('photo.tiff')).toBe(true);
    expect(isTiffName('photo.jpg')).toBe(false);
  });
  it('matches both HEIC extensions case-insensitively', () => {
    expect(isHeicName('IMG.heic')).toBe(true);
    expect(isHeicName('IMG.HEIF')).toBe(true);
    expect(isHeicName('IMG.heif')).toBe(true);
    expect(isHeicName('IMG.png')).toBe(false);
  });
});

// ---------- EXIF helpers ----------

describe('pick', () => {
  it('returns the first non-empty key in order', () => {
    expect(pick({ a: 1, b: 2 }, 'a', 'b')).toBe(1);
    expect(pick({ a: '', b: 2 }, 'a', 'b')).toBe(2);
    expect(pick({ a: null, b: 2 }, 'a', 'b')).toBe(2);
  });
  it('returns undefined when nothing matches', () => {
    expect(pick({ a: 1 }, 'b', 'c')).toBe(undefined);
    expect(pick(null, 'a')).toBe(undefined);
  });
});

describe('formatExifColorSpace', () => {
  it.each([
    [1, 'sRGB'],
    [2, 'Adobe RGB'],
    [65535, 'Uncalibrated'],
  ])('translates EXIF ColorSpace %i → %s', (input, expected) => {
    expect(formatExifColorSpace(input)).toBe(expected);
  });
  it('falls back to string representation for unknown values', () => {
    expect(formatExifColorSpace(7)).toBe('7');
    expect(formatExifColorSpace('weird')).toBe('weird');
  });
});

describe('describeColorSpace', () => {
  it('prefers ICC ProfileDescription, trimming long names to a friendly prefix', () => {
    expect(describeColorSpace({ ProfileDescription: 'sRGB IEC61966-2.1' })).toBe('sRGB');
    expect(describeColorSpace({ ProfileDescription: 'Display P3' })).toBe('Display P3');
    expect(describeColorSpace({ ProfileDescription: 'Adobe RGB (1998)' })).toBe('Adobe RGB');
  });
  it('falls back to EXIF ColorSpace when no ICC profile', () => {
    expect(describeColorSpace({ ColorSpace: 1 })).toBe('sRGB');
    expect(describeColorSpace({ ColorSpace: 2 })).toBe('Adobe RGB');
    expect(describeColorSpace({ ColorSpace: 'sRGB' })).toBe('sRGB');
  });
  it('returns empty for uncalibrated / unknown — file card hides the line then', () => {
    expect(describeColorSpace({ ColorSpace: 65535 })).toBe('');
    expect(describeColorSpace({})).toBe('');
    expect(describeColorSpace(null)).toBe('');
  });
});

describe('detectHdr', () => {
  it('recognizes UltraHDR / Adobe gain map markers', () => {
    expect(detectHdr({ 'hdrgm:Version': '1.0' })).toBe('UltraHDR');
    expect(detectHdr({ hdrgmVersion: '1.0' })).toBe('UltraHDR');
    expect(detectHdr({ HDRGain: 0.5 })).toBe('UltraHDR');
  });
  it('recognizes Apple HDR encoding', () => {
    expect(detectHdr({ AppleHDREncoding: true })).toBe('Apple HDR');
    expect(detectHdr({ AppleHDREncoding: 'true' })).toBe('Apple HDR');
    expect(detectHdr({ 'apple:HDREncoding': 1 })).toBe('Apple HDR');
  });
  it('returns empty for SDR images', () => {
    expect(detectHdr({})).toBe('');
    expect(detectHdr({ Make: 'Canon', Model: '5D' })).toBe('');
    expect(detectHdr(null)).toBe('');
  });
});

describe('describeColorMode', () => {
  it('combines bit depth with PNG colorType', () => {
    expect(describeColorMode({ BitDepth: 8, ColorType: 2 })).toBe('8-bit RGB');
    expect(describeColorMode({ BitDepth: 8, ColorType: 6 })).toBe('8-bit RGBA');
    expect(describeColorMode({ BitDepth: 16, ColorType: 0 })).toBe('16-bit Gray');
    expect(describeColorMode({ BitDepth: 8, ColorType: 3 })).toBe('8-bit Indexed');
  });
  it('uses BitsPerSample when BitDepth missing', () => {
    expect(describeColorMode({ BitsPerSample: 8, ColorType: 2 })).toBe('8-bit RGB');
  });
  it('falls back to hasAlpha when no PNG colorType', () => {
    expect(describeColorMode({ BitsPerSample: 8 }, true)).toBe('8-bit RGBA');
    expect(describeColorMode({ BitsPerSample: 8 }, false)).toBe('8-bit RGB');
    expect(describeColorMode({ BitsPerSample: 8 }, null)).toBe('8-bit');
  });
  it('handles missing data gracefully', () => {
    expect(describeColorMode({})).toBe('');
    expect(describeColorMode(null)).toBe('');
  });
});

describe('describeCaptureExtras', () => {
  it('returns one joined line per non-default extra', () => {
    const lines = describeCaptureExtras({
      WhiteBalance: 1, // Manual
      Flash: 'Flash fired, return detected',
      MeteringMode: 'CenterWeightedAverage',
      ExposureBiasValue: 0.7,
    });
    expect(lines).toEqual([
      'Manual WB · Flash fired, return detected · CenterWeightedAverage · +0.7 EV',
    ]);
  });
  it('hides default / no-flash / Unknown values', () => {
    const lines = describeCaptureExtras({
      WhiteBalance: 'Auto',
      Flash: 'No flash',
      MeteringMode: 'Unknown',
      ExposureBiasValue: 0,
    });
    expect(lines).toEqual([]);
  });
  it('handles flash as numeric bitfield (LSB = fired)', () => {
    const lines = describeCaptureExtras({ Flash: 1 });
    expect(lines).toEqual(['Flash fired']);
    expect(describeCaptureExtras({ Flash: 0 })).toEqual([]);
  });
  it('signs negative exposure compensation', () => {
    expect(describeCaptureExtras({ ExposureBiasValue: -1.3 })).toEqual(['-1.3 EV']);
  });
});

// ---------- Map URL + slippy tile math ----------

describe('mapUrl', () => {
  const lat = 25.0426, lon = 121.5600;
  it('returns the right URL per provider', () => {
    expect(mapUrl(lat, lon, 'google')).toBe(`https://www.google.com/maps?q=${lat},${lon}`);
    expect(mapUrl(lat, lon, 'apple')).toBe(`https://maps.apple.com/?q=${lat},${lon}&ll=${lat},${lon}`);
    expect(mapUrl(lat, lon, 'openstreetmap'))
      .toBe(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`);
  });
  it('returns null when provider is "none"', () => {
    expect(mapUrl(lat, lon, 'none')).toBe(null);
  });
});

describe('computeMapView', () => {
  it('produces enough tiles to cover the requested viewport', () => {
    const view = computeMapView(25.0426, 121.5600, 13, 200, 130);
    expect(view.width).toBe(200);
    expect(view.height).toBe(130);
    // 200x130 viewport at 256x256 tiles needs 1-4 tiles depending on
    // alignment with tile boundaries — assert the shape, not the count.
    expect(view.tiles.length).toBeGreaterThanOrEqual(1);
    expect(view.tiles.length).toBeLessThanOrEqual(4);
    // All URLs match the OSM tile URL shape with the right zoom level.
    for (const tile of view.tiles) {
      expect(tile.url).toMatch(/^https:\/\/tile\.openstreetmap\.org\/13\/\d+\/\d+\.png$/);
    }
  });
  it('clips tiles outside the world map (negative or > n) at low zooms', () => {
    // At zoom 0 the world is one 256x256 tile. Asking for a 600x600 view
    // around the center wraps off the map edges; we expect only the one
    // valid tile.
    const view = computeMapView(0, 0, 0, 600, 600);
    expect(view.tiles.length).toBe(1);
    expect(view.tiles[0].url).toBe('https://tile.openstreetmap.org/0/0/0.png');
  });
  it('centers the requested lat/lon — at least one tile straddles it', () => {
    // The view is centered on (lat, lon), so the world coords of that
    // point should fall inside one of the returned tiles' rendered
    // rectangles. Asserting the property rather than a specific tile
    // index keeps the test resilient to minor algorithm tweaks.
    const lat = 25.033, lon = 121.5654, zoom = 13;
    const view = computeMapView(lat, lon, zoom, 256, 256);
    // Tile (left=0..256-tileLeft) etc. — for a 256x256 viewport, the
    // marker is rendered at the center, so the point at (128, 128) in
    // viewport coords must land inside one of the tiles.
    const hits = view.tiles.filter(
      (t) => t.left <= 128 && t.left + 256 >= 128 && t.top <= 128 && t.top + 256 >= 128,
    );
    expect(hits.length).toBeGreaterThan(0);
  });
});
