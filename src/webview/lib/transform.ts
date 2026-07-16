// Pure fit-scale/zoom math — no DOM, no globals. Shared by main.ts's
// applyTransform (sizes the live <img>/<canvas> element) and
// analyzeImageSample's stage-miniature sampler (same contain-fit rect at
// zoom=1, then scaled further down into the 200x200 sample canvas).

export interface DisplaySize {
  w: number;
  h: number;
}

// Contain-fit `naturalW x naturalH` inside `stageW x stageH`, never
// upscaling past natural size at zoom=1 (fitScale caps at 1), then apply
// `zoom` on top. Returns null when natural dimensions aren't known yet (0)
// — callers fall back to letting CSS max-width/max-height size the element.
export function computeDisplaySize(
  naturalW: number,
  naturalH: number,
  stageW: number,
  stageH: number,
  zoom: number,
): DisplaySize | null {
  if (!naturalW || !naturalH) return null;
  const fitScale = Math.min(stageW / naturalW, stageH / naturalH, 1);
  const display = fitScale * zoom;
  return { w: naturalW * display, h: naturalH * display };
}
