import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';

interface ImageDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

// Formats we can render in the webview (must match package.json `customEditors.selector`).
// TIFF goes through utif, HEIC/HEIF goes through libheif-js worker; SVG is
// handled natively by `<img>`.
const SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.avif',
  '.tiff', '.tif', '.heic', '.heif', '.ico', '.svg',
]);

// Formats decoded off the main <img> pipeline (utif / libheif-js worker)
// instead of native <img> decode. buildHtml omits <img src> for these —
// emitting it would start a doomed native-decode attempt that main.ts
// immediately aborts and re-fetches from scratch, reading the file twice.
const DEFERRED_DECODE_EXTS: ReadonlySet<string> = new Set([
  '.tiff', '.tif', '.heic', '.heif',
]);

interface SiblingItem {
  canonicalUri: string;  // document-scheme Uri.toString(), for the opened-file match
  uri: string;           // webview-uri string, ready to drop into <img src>
  name: string;
  size: number;
  mtime: number;
  ctime: number;
}

type SortBy = 'filename' | 'mtime' | 'ctime' | 'size';
type SortOrder = 'asc' | 'desc';

export class ImageOverlayEditorProvider implements vscode.CustomReadonlyEditorProvider<ImageDocument> {
  public static readonly viewType = 'imageOverlay.preview';

  private activePanel: vscode.WebviewPanel | undefined;

  // Session-scoped UI state shared across all webviews of this provider.
  // Lifecycle = extension-host process: persists when the user clicks a
  // different image (which spawns a fresh webview), resets only when the
  // user reloads / quits VS Code. Deliberately NOT in workspaceState /
  // globalState because that would survive restarts, which the user
  // explicitly didn't want.
  private histogramOn = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public postToActive(message: unknown) {
    this.activePanel?.webview.postMessage(message);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<ImageDocument> {
    return { uri, dispose: () => {} };
  }

  async resolveCustomEditor(
    document: ImageDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    // Scheme-preserving parent dir. Uri.file(path.dirname(uri.fsPath)) would
    // drop scheme + authority (and flip separators on Windows), so on
    // vscode-remote / WSL / container / virtual filesystems the image itself
    // falls outside localResourceRoots and never loads. joinPath(uri, '..')
    // keeps scheme + authority intact.
    const imageDir = vscode.Uri.joinPath(document.uri, '..');

    // Declared before the first await (the stat below) so a panel closed
    // mid-resolve can't be written to (options/html) after disposal.
    let panelDisposed = false;
    webviewPanel.onDidDispose(() => { panelDisposed = true; });

    const config = vscode.workspace.getConfiguration('imageOverlay');
    const defaultVisible = config.get<boolean>('defaultVisible', true);
    const autoContrast = config.get<boolean>('autoContrast', true);
    const showHint = config.get<boolean>('showHintOnOpen', true);
    const gpsMapProvider = config.get<string>('gpsMapProvider', 'openstreetmap');
    const sortBy = (config.get<string>('browseSortBy', 'filename') as SortBy);
    const sortOrder = (config.get<string>('browseSortOrder', 'asc') as SortOrder);
    const browseLoop = config.get<boolean>('browseLoop', false);
    const slideshowIntervalMs = Math.min(30000, Math.max(500,
      config.get<number>('slideshowIntervalMs', 3000)));

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(document.uri);
    } catch {
      // File unreadable (permissions, deleted mid-open, provider error).
      // Show a static message instead of leaving an unhandled rejection.
      if (!panelDisposed) {
        try {
          const cspSource = webviewPanel.webview.cspSource;
          webviewPanel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';">
<title>Image Overlay Preview</title>
</head>
<body><p>The image file could not be read.</p></body>
</html>`;
        } catch { /* panel disposed between the check above and now */ }
      }
      return;
    }

    // Panel may have been disposed during the stat await — don't write to it.
    if (panelDisposed) return;

    // Paint immediately: assign options + HTML now, before sibling
    // enumeration even starts. Folders with thousands of images used to
    // block first paint on a sequential per-file stat loop; siblings now
    // arrive afterwards over postMessage (see below). The try/catch is a
    // backstop for the (check → write) disposal race.
    try {
      webviewPanel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
          imageDir,
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        ],
      };
      webviewPanel.webview.html = this.buildHtml(
        webviewPanel.webview,
        document.uri,
        {
          filename: basenameOf(document.uri),
          fileSize: stat.size,
          mtime: stat.mtime,
          defaultVisible,
          autoContrast,
          showHint,
          gpsMapProvider,
          siblings: [],
          currentIndex: 0,
          browseLoop,
          slideshowIntervalMs,
          histogramOn: this.histogramOn,
        }
      );
    } catch {
      return; /* panel disposed between the check above and the write */
    }

    // Enumerate sibling images in the background — sort once on host so the
    // webview can navigate purely by index. ~1000 entries × ~200 bytes each
    // is well under the postMessage limit; we send the whole list up front
    // rather than round-tripping per nav for snap responsiveness during
    // slideshow. Delivered exactly once, after both enumeration and the
    // webview's 'ready' handshake have completed — whichever lands last
    // triggers the post.
    let webviewReady = false;
    let siblingsSent = false;
    let siblings: SiblingItem[] | undefined;

    const postSiblingsIfReady = () => {
      if (!webviewReady || panelDisposed || siblingsSent) return;
      const result = siblings;
      if (result === undefined) return;
      siblingsSent = true;
      // -1 (not Math.max(0, …)) when the opened file isn't in the enumerated
      // list — the webview treats -1 as "not in list" rather than anchoring
      // navigation to the wrong (index 0) sibling. Compare canonical Uri
      // strings so scheme/authority/encoding are handled consistently.
      const currentIndex = result.findIndex(
        (s) => s.canonicalUri === document.uri.toString(),
      );
      try {
        webviewPanel.webview.postMessage({
          type: 'siblings',
          siblings: result.map((s) => ({
            uri: s.uri,
            name: s.name,
            size: s.size,
            mtime: s.mtime,
            ctime: s.ctime,
          })),
          currentIndex,
        });
      } catch {
        /* panel disposed between the check above and now */
      }
    };

    this.enumerateSiblings(webviewPanel.webview, document.uri, sortBy, sortOrder)
      .then((result) => {
        siblings = result;
        postSiblingsIfReady();
      })
      .catch((err) => {
        console.error('imageOverlay: sibling enumeration failed', err);
        siblings = [];
        postSiblingsIfReady();
      });

    // Sync session-scoped UI toggles from webview back into the host so
    // newly-opened images inherit the current state; also catches the
    // webview's boot handshake so siblings can be posted (see above).
    webviewPanel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; value?: unknown };
      if (m.type === 'histogramToggle') {
        this.histogramOn = !!m.value;
      } else if (m.type === 'ready') {
        webviewReady = true;
        postSiblingsIfReady();
      }
    });

    const setActive = (panel: vscode.WebviewPanel | undefined) => {
      this.activePanel = panel;
    };
    // Only claim active if this panel actually has focus at resolve time;
    // onDidChangeViewState maintains it afterwards. A background-resolved
    // panel (e.g. restored on reload) must not steal activePanel.
    if (webviewPanel.active) setActive(webviewPanel);

    webviewPanel.onDidChangeViewState((e) => {
      setActive(e.webviewPanel.active ? e.webviewPanel : this.activePanel === e.webviewPanel ? undefined : this.activePanel);
    });
    webviewPanel.onDidDispose(() => {
      if (this.activePanel === webviewPanel) setActive(undefined);
    });

    // Live refresh if the file changes on disk. createFileSystemWatcher(fsPath)
    // used to hand the raw absolute path to the GlobPattern string overload —
    // on Windows backslashes are glob escape characters, so the pattern never
    // matched and this feature was silently dead. Watch the containing
    // directory (non-recursive '*', matching enumerateSiblings) and filter
    // events down to the opened file instead. Filtering via the basename as
    // the glob pattern would just trade one bug for another: '[', ']', '{',
    // '}' are legal in filenames and are also glob special characters.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(imageDir, '*'));
    const refresh = async (uri: vscode.Uri) => {
      if (!samePath(uri.fsPath, document.uri.fsPath)) return;
      try {
        const s = await vscode.workspace.fs.stat(document.uri);
        webviewPanel.webview.postMessage({
          type: 'fileUpdate',
          fileSize: s.size,
          mtime: s.mtime,
          cacheBust: Date.now(),
        });
      } catch {
        /* file removed */
      }
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    webviewPanel.onDidDispose(() => watcher.dispose());
  }

  private async enumerateSiblings(
    webview: vscode.Webview,
    currentUri: vscode.Uri,
    sortBy: SortBy,
    sortOrder: SortOrder,
  ): Promise<SiblingItem[]> {
    // Scheme-preserving parent dir (see resolveCustomEditor) — Uri.file(dir)
    // would break enumeration on remote/virtual filesystems.
    const dirUri = vscode.Uri.joinPath(currentUri, '..');
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return [];
    }
    const candidates = entries.filter(([name, type]) => {
      if (type !== vscode.FileType.File) return false;
      return SUPPORTED_EXTS.has(extOf(name));
    });
    // Stat calls fire in parallel, but in bounded batches — a flat Promise.all
    // over tens of thousands of files can stampede the FS provider (especially
    // remote/virtual) and drop entries nondeterministically. Keeping ≤64 in
    // flight preserves fast first paint without the stampede; per-file
    // failures still skip silently.
    const BATCH = 64;
    const items: SiblingItem[] = [];
    for (let i = 0; i < candidates.length; i += BATCH) {
      const stated = await Promise.all(
        candidates.slice(i, i + BATCH).map(async ([name]): Promise<SiblingItem | undefined> => {
          const fileUri = vscode.Uri.joinPath(dirUri, name);
          try {
            const s = await vscode.workspace.fs.stat(fileUri);
            return {
              canonicalUri: fileUri.toString(),
              uri: webview.asWebviewUri(fileUri).toString(),
              name,
              size: s.size,
              mtime: s.mtime,
              ctime: s.ctime,
            };
          } catch {
            return undefined; /* skip unreadable */
          }
        }),
      );
      for (const item of stated) if (item !== undefined) items.push(item);
    }
    const cmp = (a: SiblingItem, b: SiblingItem): number => {
      let r = 0;
      if (sortBy === 'mtime') r = a.mtime - b.mtime;
      else if (sortBy === 'ctime') r = a.ctime - b.ctime;
      else if (sortBy === 'size') r = a.size - b.size;
      else r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      // Tie-break by filename so order is deterministic across runs.
      if (r === 0 && sortBy !== 'filename') r = a.name.localeCompare(b.name);
      return sortOrder === 'desc' ? -r : r;
    };
    items.sort(cmp);
    return items;
  }

  private buildHtml(
    webview: vscode.Webview,
    imageUri: vscode.Uri,
    ctx: {
      filename: string;
      fileSize: number;
      mtime: number;
      defaultVisible: boolean;
      autoContrast: boolean;
      showHint: boolean;
      gpsMapProvider: string;
      siblings: SiblingItem[];
      currentIndex: number;
      browseLoop: boolean;
      slideshowIntervalMs: number;
      histogramOn: boolean;
    }
  ): string {
    const imageWebUri = webview.asWebviewUri(imageUri);
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'viewer.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'viewer.css')
    );
    // Resolved up front and passed in via ctx so the webview doesn't need
    // to know how to construct webview URIs. Lazy-loaded by main.ts only
    // when a HEIC/HEIF file is opened.
    const heicWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'heic-worker.js')
    );
    // Same idea — lazy-loaded by main.ts only when a TIFF/TIF file is opened.
    const tiffWorkerUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'tiff-worker.js')
    );
    const cspSource = webview.cspSource;
    const nonce = getNonce();

    // TIFF/HEIC/HEIF are decoded by a worker (utif / libheif-js) into a
    // blob URL rather than rendered natively — see DEFERRED_DECODE_EXTS.
    // Provider already knows the opened file's extension, so it can skip
    // emitting <img src> for those formats instead of letting main.ts
    // start-then-abort a native decode of bytes it can't use.
    const ext = extOf(basenameOf(imageUri));
    const imgTag = DEFERRED_DECODE_EXTS.has(ext)
      ? `<img id="img" alt="" draggable="false">`
      : `<img id="img" src="${imageWebUri}" alt="" draggable="false">`;

    const injectedCtx = {
      filename: ctx.filename,
      fileSize: ctx.fileSize,
      mtime: ctx.mtime,
      imageUri: imageWebUri.toString(),
      defaultVisible: ctx.defaultVisible,
      autoContrast: ctx.autoContrast,
      showHint: ctx.showHint,
      gpsMapProvider: ctx.gpsMapProvider,
      siblings: ctx.siblings.map((s) => ({
        // canonicalUri is internal — webview only needs uri/name/size/mtime/ctime
        uri: s.uri,
        name: s.name,
        size: s.size,
        mtime: s.mtime,
        ctime: s.ctime,
      })),
      currentIndex: ctx.currentIndex,
      browseLoop: ctx.browseLoop,
      slideshowIntervalMs: ctx.slideshowIntervalMs,
      histogramOn: ctx.histogramOn,
      heicWorkerUri: heicWorkerUri.toString(),
      tiffWorkerUri: tiffWorkerUri.toString(),
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https://tile.openstreetmap.org; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' blob: 'wasm-unsafe-eval'; worker-src blob:; connect-src ${cspSource};">
<link href="${styleUri}" rel="stylesheet">
<title>${escapeHtml(ctx.filename)}</title>
</head>
<body>
  <div id="stage">
    <div id="img-wrap">${imgTag}</div>
  </div>
  <div id="overlay-tl" class="overlay corner tl"></div>
  <div id="overlay-tr" class="overlay corner tr"></div>
  <div id="overlay-bl" class="overlay corner bl"></div>
  <div id="overlay-br" class="overlay corner br"></div>
  <div id="histogram"><canvas></canvas><div class="hist-status">computing…</div></div>
  <div id="hint" class="hint"><kbd>I</kbd> toggle · <kbd>E</kbd> expand · <kbd>H</kbd> histogram · <kbd>0</kbd> reset · <kbd>←</kbd> <kbd>→</kbd> browse · <kbd>Space</kbd> slideshow</div>
  <script nonce="${nonce}">window.__IMG_CTX__ = ${JSON.stringify(injectedCtx).replace(/</g, '\\u003c')};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// Last path segment of a Uri, taken from its posix `path` (NOT fsPath, which
// drops scheme/authority and flips separators on Windows). For a plain local
// file this equals path.basename(uri.fsPath); on remote/virtual URIs it stays
// correct where fsPath would not.
function basenameOf(uri: vscode.Uri): string {
  const p = uri.path;
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

// Lowercased extension (including the dot) of a filename, matching
// path.extname's leading-dot rule — a dotfile like ".gitignore" has none.
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

// Path equality for the live-refresh watcher filter: normalizes separators
// and matches Windows' case-insensitive filesystem semantics (win32 only —
// other platforms are typically case-sensitive on disk).
function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  // crypto.randomBytes, not Math.random — this nonce gates script-src in the
  // CSP, so it needs to be unguessable. Modulo-62 over 256 byte values has a
  // slight bias (256 % 62 !== 0) but that's fine for a nonce, not a secret.
  const bytes = crypto.randomBytes(32);
  for (let i = 0; i < 32; i++) out += chars.charAt(bytes[i] % chars.length);
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
