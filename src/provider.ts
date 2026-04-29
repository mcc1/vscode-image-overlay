import * as vscode from 'vscode';
import * as path from 'path';

interface ImageDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

// Formats we can render in the webview (must match package.json `customEditors.selector`).
// TIFF rendering goes through utif in the webview; SVG is handled natively by `<img>`.
const SUPPORTED_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.avif', '.tiff', '.tif', '.ico', '.svg',
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

    // Enumerate sibling images in the same folder. Sort once on host so the
    // webview can navigate purely by index. ~1000 entries × ~200 bytes each
    // is well under the postMessage limit; we send the whole list up front
    // rather than round-tripping per nav for snap responsiveness during
    // slideshow.
    const siblings = await this.enumerateSiblings(
      webviewPanel.webview,
      document.uri,
      sortBy,
      sortOrder,
    );
    const currentIndex = Math.max(
      0,
      siblings.findIndex((s) => s.fsPath === document.uri.fsPath),
    );

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
        siblings,
        currentIndex,
        browseLoop,
        slideshowIntervalMs,
        histogramOn: this.histogramOn,
      }
    );

    // Sync session-scoped UI toggles from webview back into the host so
    // newly-opened images inherit the current state.
    webviewPanel.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { type?: string; value?: unknown };
      if (m.type === 'histogramToggle') {
        this.histogramOn = !!m.value;
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
      if (this.activePanel === webviewPanel) setActive(undefined);
    });

    // Live refresh if the file changes on disk
    const watcher = vscode.workspace.createFileSystemWatcher(document.uri.fsPath);
    const refresh = async () => {
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
    const items: SiblingItem[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) continue;
      const ext = path.extname(name).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) continue;
      const fullPath = path.join(dir, name);
      try {
        const s = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
        items.push({
          fsPath: fullPath,
          uri: webview.asWebviewUri(vscode.Uri.file(fullPath)).toString(),
          name,
          size: s.size,
          mtime: s.mtime,
          ctime: s.ctime,
        });
      } catch {
        /* skip unreadable */
      }
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
    const cspSource = webview.cspSource;
    const nonce = getNonce();

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
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob: https://tile.openstreetmap.org https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' blob:; worker-src blob:; font-src ${cspSource}; connect-src ${cspSource};">
<link href="${styleUri}" rel="stylesheet">
<title>${escapeHtml(ctx.filename)}</title>
</head>
<body>
  <div id="stage">
    <img id="img" src="${imageWebUri}" alt="" draggable="false">
  </div>
  <div id="overlay-tl" class="overlay corner tl"></div>
  <div id="overlay-tr" class="overlay corner tr"></div>
  <div id="overlay-bl" class="overlay corner bl"></div>
  <div id="overlay-br" class="overlay corner br"></div>
  <div id="histogram"><canvas></canvas><div class="hist-status">computing…</div></div>
  <div id="hint" class="hint"><kbd>I</kbd> toggle · <kbd>E</kbd> expand · <kbd>H</kbd> histogram · <kbd>0</kbd> reset · <kbd>←</kbd> <kbd>→</kbd> browse · <kbd>Space</kbd> slideshow</div>
  <script nonce="${nonce}">window.__IMG_CTX__ = ${JSON.stringify(injectedCtx)};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
