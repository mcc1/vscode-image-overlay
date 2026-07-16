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
  fsPath: string;
  uri: string;       // webview-uri string, ready to drop into <img src>
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
    const imageDir = vscode.Uri.file(path.dirname(document.uri.fsPath));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        imageDir,
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    const config = vscode.workspace.getConfiguration('imageOverlay');
    const defaultVisible = config.get<boolean>('defaultVisible', true);
    const autoContrast = config.get<boolean>('autoContrast', true);
    const showHint = config.get<boolean>('showHintOnOpen', true);
    const gpsMapProvider = config.get<string>('gpsMapProvider', 'openstreetmap');
    const sortBy = (config.get<string>('browseSortBy', 'filename') as SortBy);
    const sortOrder = (config.get<string>('browseSortOrder', 'asc') as SortOrder);
    const browseLoop = config.get<boolean>('browseLoop', false);
    const slideshowIntervalMs = Math.max(500,
      config.get<number>('slideshowIntervalMs', 3000));

    const stat = await vscode.workspace.fs.stat(document.uri);

    // Paint immediately: assign the webview HTML now, before sibling
    // enumeration even starts. Folders with thousands of images used to
    // block first paint on a sequential per-file stat loop; siblings now
    // arrive afterwards over postMessage (see below).
    webviewPanel.webview.html = this.buildHtml(
      webviewPanel.webview,
      document.uri,
      {
        filename: path.basename(document.uri.fsPath),
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

    // Enumerate sibling images in the background — sort once on host so the
    // webview can navigate purely by index. ~1000 entries × ~200 bytes each
    // is well under the postMessage limit; we send the whole list up front
    // rather than round-tripping per nav for snap responsiveness during
    // slideshow. Delivered exactly once, after both enumeration and the
    // webview's 'ready' handshake have completed — whichever lands last
    // triggers the post.
    let panelDisposed = false;
    let webviewReady = false;
    let siblingsSent = false;
    let siblings: SiblingItem[] | undefined;

    const postSiblingsIfReady = () => {
      if (!webviewReady || panelDisposed || siblingsSent) return;
      const result = siblings;
      if (result === undefined) return;
      siblingsSent = true;
      const currentIndex = Math.max(
        0,
        result.findIndex((s) => s.fsPath === document.uri.fsPath),
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
    setActive(webviewPanel);

    webviewPanel.onDidChangeViewState((e) => {
      setActive(e.webviewPanel.active ? e.webviewPanel : this.activePanel === e.webviewPanel ? undefined : this.activePanel);
    });
    webviewPanel.onDidDispose(() => {
      panelDisposed = true;
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
    const dir = path.dirname(currentUri.fsPath);
    const dirUri = vscode.Uri.file(dir);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dirUri);
    } catch {
      return [];
    }
    const candidates = entries.filter(([name, type]) => {
      if (type !== vscode.FileType.File) return false;
      return SUPPORTED_EXTS.has(path.extname(name).toLowerCase());
    });
    // Stat calls fire in parallel — a sequential await-per-file loop here
    // was the first-paint bottleneck in folders with thousands of images.
    const stated = await Promise.all(candidates.map(async ([name]): Promise<SiblingItem | undefined> => {
      const fullPath = path.join(dir, name);
      try {
        const s = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
        return {
          fsPath: fullPath,
          uri: webview.asWebviewUri(vscode.Uri.file(fullPath)).toString(),
          name,
          size: s.size,
          mtime: s.mtime,
          ctime: s.ctime,
        };
      } catch {
        return undefined; /* skip unreadable */
      }
    }));
    const items = stated.filter((item): item is SiblingItem => item !== undefined);
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
    const ext = path.extname(imageUri.fsPath).toLowerCase();
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
        // fsPath is internal — webview only needs uri/name/size/mtime/ctime
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob: https://tile.openstreetmap.org https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' blob: 'wasm-unsafe-eval'; worker-src ${cspSource} blob:; font-src ${cspSource}; connect-src ${cspSource};">
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
