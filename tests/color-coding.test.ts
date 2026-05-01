import { describe, it, expect } from 'vitest';
import {
  describeColourTriple,
  isHdrTransfer,
  describeHdrFromTransfer,
} from '../src/webview/lib/color-coding.js';

describe('describeColourTriple', () => {
  it('Rec.2020 PQ for (9, 16)', () => {
    expect(describeColourTriple({ primaries: 9, transfer: 16 })).toBe('Rec.2020 PQ');
  });
  it('Rec.2020 HLG for (9, 18)', () => {
    expect(describeColourTriple({ primaries: 9, transfer: 18 })).toBe('Rec.2020 HLG');
  });
  it('Display P3 for (12, 13)', () => {
    expect(describeColourTriple({ primaries: 12, transfer: 13 })).toBe('Display P3');
  });
  it('sRGB for (1, 13)', () => {
    expect(describeColourTriple({ primaries: 1, transfer: 13 })).toBe('sRGB');
  });
  it('Rec.709 for (1, 1)', () => {
    expect(describeColourTriple({ primaries: 1, transfer: 1 })).toBe('Rec.709');
  });
  it('falls back to gamut-only label for unknown transfers', () => {
    expect(describeColourTriple({ primaries: 9, transfer: 99 })).toBe('Rec.2020');
    expect(describeColourTriple({ primaries: 12, transfer: 99 })).toBe('P3');
    expect(describeColourTriple({ primaries: 1, transfer: 99 })).toBe('Rec.709');
  });
  it('returns empty string for unknown primaries', () => {
    expect(describeColourTriple({ primaries: 0, transfer: 13 })).toBe('');
    expect(describeColourTriple({ primaries: 99, transfer: 16 })).toBe('');
  });
});

describe('isHdrTransfer', () => {
  it('true for 16 (PQ) and 18 (HLG)', () => {
    expect(isHdrTransfer(16)).toBe(true);
    expect(isHdrTransfer(18)).toBe(true);
  });
  it('false for SDR transfers and unknown values', () => {
    expect(isHdrTransfer(1)).toBe(false);
    expect(isHdrTransfer(13)).toBe(false);
    expect(isHdrTransfer(0)).toBe(false);
    expect(isHdrTransfer(99)).toBe(false);
  });
});

describe('describeHdrFromTransfer', () => {
  it('HDR10 (PQ) for 16', () => {
    expect(describeHdrFromTransfer(16)).toBe('HDR10 (PQ)');
  });
  it('HLG for 18', () => {
    expect(describeHdrFromTransfer(18)).toBe('HLG');
  });
  it('empty for non-HDR transfers', () => {
    expect(describeHdrFromTransfer(13)).toBe('');
    expect(describeHdrFromTransfer(1)).toBe('');
    expect(describeHdrFromTransfer(0)).toBe('');
  });
});
