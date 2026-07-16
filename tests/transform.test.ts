import { describe, it, expect } from 'vitest';
import { computeDisplaySize } from '../src/webview/lib/transform.js';

describe('computeDisplaySize', () => {
  it('caps fit at 1 for a 1x1 image in an 800x600 stage', () => {
    expect(computeDisplaySize(1, 1, 800, 600, 1)).toEqual({ w: 1, h: 1 });
  });

  it('contain-fits a huge image on both axes, picking the smaller ratio', () => {
    // 800/4000 = 0.2 (width-limited) vs 600/2000 = 0.3 — fitScale = 0.2.
    expect(computeDisplaySize(4000, 2000, 800, 600, 1)).toEqual({ w: 800, h: 400 });
  });

  it('handles a degenerate 40000x2 panorama without blowing up', () => {
    // 800/40000 = 0.02 (width-limited) vs 600/2 = 300 — fitScale = 0.02.
    expect(computeDisplaySize(40000, 2, 800, 600, 1)).toEqual({ w: 800, h: 0.04 });
  });

  it('scales the contain-fit rect by zoom', () => {
    // fitScale = min(1000/2000, 1000/1000, 1) = 0.5, then *zoom 3 = 1.5.
    expect(computeDisplaySize(2000, 1000, 1000, 1000, 3)).toEqual({ w: 3000, h: 1500 });
  });

  it('shrinks to fit when the stage is smaller than the image on both axes', () => {
    // fitScale = min(300/3000, 600/3000, 1) = 0.1.
    expect(computeDisplaySize(3000, 3000, 300, 600, 1)).toEqual({ w: 300, h: 300 });
  });

  it('returns null when natural dimensions are not yet known (0)', () => {
    expect(computeDisplaySize(0, 100, 800, 600, 1)).toBeNull();
    expect(computeDisplaySize(100, 0, 800, 600, 1)).toBeNull();
    expect(computeDisplaySize(0, 0, 800, 600, 1)).toBeNull();
  });
});
