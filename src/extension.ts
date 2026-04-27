import * as vscode from 'vscode';
import { ImageOverlayEditorProvider } from './provider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new ImageOverlayEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ImageOverlayEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    ),
    vscode.commands.registerCommand('imageOverlay.toggleOverlay', () => {
      provider.postToActive({ type: 'toggleOverlay' });
    }),
    vscode.commands.registerCommand('imageOverlay.toggleExpanded', () => {
      provider.postToActive({ type: 'toggleExpanded' });
    })
  );
}

export function deactivate() {}
