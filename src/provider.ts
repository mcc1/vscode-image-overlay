import * as vscode from 'vscode';
import * as path from 'path';

interface ImageDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

export class ImageOverlayEditorProvider implements vscode.CustomReadonlyEditorProvider<ImageDocument> {
  public static readonly viewType = 'imageOverlay.preview';

  private activePanel: vscode.WebviewPanel | undefined;

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

    const stat = await vscode.workspace.fs.stat(document.uri);

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
      }
    );

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
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data: blob: https://tile.openstreetmap.org https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource}; connect-src ${cspSource};">
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
  <div id="hint" class="hint"><kbd>I</kbd> toggle · <kbd>E</kbd> expand · <kbd>0</kbd> reset · scroll zoom · drag pan</div>
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
