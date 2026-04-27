import esbuild from 'esbuild';

const prod = process.argv.includes('--prod');
const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
};

const extensionConfig = {
  ...shared,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webviewConfig = {
  ...shared,
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/viewer.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

if (watch) {
  const ctx1 = await esbuild.context(extensionConfig);
  const ctx2 = await esbuild.context(webviewConfig);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log('[esbuild] watching…');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
}
