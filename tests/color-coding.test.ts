import { describe, it, expect } from 'vitest';
import {
  describeColourTriple,
  describeHdrFromTransfer,
} from '../src/webview/lib/color-coding.js';

describe('describeColourTriple', () => {
  it('names the four real-world combinations', () => {
    expect(describeColourTriple({ primaries: 9, transfer: 16 })).toBe('Rec.2020 PQ');
    expect(describeColourTriple({ primaries: 9, transfer: 18 })).toBe('Rec.2020 HLG');
    expect(describeColourTriple({ primaries: 12, transfer: 13 })).toBe('Display P3');
    expect(describeColourTriple({ primaries: 1, transfer: 13 })).toBe('sRGB');
    expect(describeColourTriple({ primaries: 1, transfer: 1 })).toBe('Rec.709');
  });
  it('falls back to gamut-only label for unknown transfers', () => {
    expect(describeColourTriple({ primaries: 9, transfer: 99 })).toBe('Rec.2020');
    expect(describeColourTriple({ primaries: 12, transfer: 99 })).toBe('P3');
  });
  it('returns empty string for unknown primaries', () => {
    expect(describeColourTriple({ primaries: 0, transfer: 13 })).toBe('');
  });
});

describe('describeHdrFromTransfer', () => {
  it('labels PQ and HLG', () => {
    expect(describeHdrFromTransfer(16)).toBe('HDR10 (PQ)');
    expect(describeHdrFromTransfer(18)).toBe('HLG');
  });
  it('empty for non-HDR transfers', () => {
    expect(describeHdrFromTransfer(13)).toBe('');
    expect(describeHdrFromTransfer(1)).toBe('');
  });
});
