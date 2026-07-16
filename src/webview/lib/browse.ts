// Pure sibling/URI browsing helpers — no DOM, no globals. Extracted from
// main.ts's decoded-neighbor cache so the wrap/loop math is testable without
// spinning up a webview.

// fileUpdate cache-busted URIs (…?v=N / …&v=N) are one-shot: never cache or
// prefetch them, and when a bust arrives evict the plain-URI entry — a
// navigate-away-and-back must not repaint the pre-edit pixels.
export function isBustedUri(uri: string): boolean {
  return /[?&]v=\d+$/.test(uri);
}

export interface BrowseSibling {
  uri: string;
}

// URIs worth keeping decoded: the current image plus its immediate neighbors
// (honoring browseLoop). currentUri is included too — it may be a `?v=`
// cache-busted variant that isn't in siblings.
export function wantedDecodedUris(
  currentUri: string | null,
  currentIndex: number,
  siblings: BrowseSibling[],
  browseLoop: boolean,
): Set<string> {
  const wanted = new Set<string>();
  if (currentUri) wanted.add(currentUri);
  const n = siblings.length;
  const cur = currentIndex;
  const curSib = siblings[cur];
  if (curSib) wanted.add(curSib.uri);
  // Anchor unknown (currentIndex -1: opened file not in the sibling list):
  // neighbor math would wrap onto arbitrary ends, so keep only the current uri.
  if (cur < 0) return wanted;
  for (const dir of [-1, 1] as const) {
    let idx = cur + dir;
    if (idx < 0) idx = browseLoop ? n - 1 : -1;
    else if (idx >= n) idx = browseLoop ? 0 : -1;
    if (idx < 0 || idx === cur) continue;
    const sib = siblings[idx];
    if (sib) wanted.add(sib.uri);
  }
  return wanted;
}
