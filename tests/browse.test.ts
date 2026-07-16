import { describe, it, expect } from 'vitest';
import { isBustedUri, wantedDecodedUris, type BrowseSibling } from '../src/webview/lib/browse.js';

describe('isBustedUri', () => {
  it('is false for a plain uri with no query', () => {
    expect(isBustedUri('vscode-webview://abc/photo.jpg')).toBe(false);
  });
  it('is true for a ?v=N cache-bust suffix', () => {
    expect(isBustedUri('vscode-webview://abc/photo.jpg?v=123')).toBe(true);
  });
  it('is true for a &v=N cache-bust suffix following another query param', () => {
    expect(isBustedUri('vscode-webview://abc/photo.jpg?x=1&v=456')).toBe(true);
  });
  it('is false for an unrelated query param', () => {
    expect(isBustedUri('vscode-webview://abc/photo.jpg?x=1')).toBe(false);
  });
  it('is false when ?v= appears mid-string, not anchored at the end', () => {
    expect(isBustedUri('vscode-webview://abc/photo.jpg?v=123&x=1')).toBe(false);
  });
});

describe('wantedDecodedUris', () => {
  const sibs = (n: number): BrowseSibling[] =>
    Array.from({ length: n }, (_, i) => ({ uri: `uri-${i}` }));

  it('middle index wants current plus both neighbors (3)', () => {
    const s = sibs(5);
    const wanted = wantedDecodedUris(s[2].uri, 2, s, false);
    expect(wanted).toEqual(new Set(['uri-1', 'uri-2', 'uri-3']));
  });

  it('index 0 with no loop wants only current + next (2)', () => {
    const s = sibs(5);
    const wanted = wantedDecodedUris(s[0].uri, 0, s, false);
    expect(wanted).toEqual(new Set(['uri-0', 'uri-1']));
  });

  it('index 0 with loop wraps the "previous" neighbor to the last sibling', () => {
    const s = sibs(5);
    const wanted = wantedDecodedUris(s[0].uri, 0, s, true);
    expect(wanted).toEqual(new Set(['uri-4', 'uri-0', 'uri-1']));
  });

  it('last index with loop wraps the "next" neighbor to the first sibling', () => {
    const s = sibs(5);
    const wanted = wantedDecodedUris(s[4].uri, 4, s, true);
    expect(wanted).toEqual(new Set(['uri-3', 'uri-4', 'uri-0']));
  });

  it('n=1 wants only the current uri regardless of loop', () => {
    const s = sibs(1);
    expect(wantedDecodedUris(s[0].uri, 0, s, false)).toEqual(new Set(['uri-0']));
    expect(wantedDecodedUris(s[0].uri, 0, s, true)).toEqual(new Set(['uri-0']));
  });

  it('n=2 with loop does not self-wrap duplicate the lone neighbor', () => {
    const s = sibs(2);
    const wanted = wantedDecodedUris(s[0].uri, 0, s, true);
    // Both -1 and +1 wrap/step onto index 1 — must appear once, and the
    // result must not include index 0 twice via a phantom self-wrap.
    expect(wanted).toEqual(new Set(['uri-0', 'uri-1']));
    expect(wanted.size).toBe(2);
  });

  it('currentIndex -1 (anchor unknown) returns only currentUri, skipping neighbor math', () => {
    const s = sibs(3);
    const wanted = wantedDecodedUris('busted-uri?v=1', -1, s, true);
    expect(wanted).toEqual(new Set(['busted-uri?v=1']));
  });

  it('currentUri null contributes nothing beyond the resolved sibling set', () => {
    const s = sibs(3);
    const wanted = wantedDecodedUris(null, 1, s, false);
    expect(wanted).toEqual(new Set(['uri-0', 'uri-1', 'uri-2']));
  });
});
