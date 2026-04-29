#!/usr/bin/env node
// One-shot release helper.
//
//   npm run release            → patch bump
//   npm run release -- minor   → minor bump
//   npm run release -- major   → major bump
//
// What it does:
//   1. npm version <bump>          (bumps package.json + creates git tag)
//   2. git push --follow-tags       (kicks off the Release workflow on CI)
//   3. Polls until the matching CI run appears, then watches it to completion
//   4. Downloads the built vsix from the GitHub release into ./dist-release/
//   5. Opens the marketplace publisher dashboard in the default browser so
//      the user can drag the vsix in (the only step we can't automate
//      because we don't have an Azure DevOps PAT).
//
// Designed to fail loudly: any non-zero exit aborts the chain. Re-running
// after a partial failure is safe — `npm version` refuses if the tag
// already exists, `gh release download --clobber` is idempotent.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const RELEASE_DIR = 'dist-release';
const PUBLISHER_URL = 'https://marketplace.visualstudio.com/manage/publishers/mcc';
const WORKFLOW_FILE = 'release.yml';
const PRE_RUN_DELAY_MS = 6000;       // give GitHub time to register the tag push
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 60000;

function step(msg) {
  process.stdout.write(`\n▶ ${msg}\n`);
}

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

function runCapture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function pkgVersion() {
  return JSON.parse(readFileSync('./package.json', 'utf8')).version;
}

function openInBrowser(url) {
  // process.platform → win32 / darwin / linux (and others)
  const cmd =
    process.platform === 'win32'  ? ['cmd', ['/c', 'start', '', url]] :
    process.platform === 'darwin' ? ['open', [url]] :
                                     ['xdg-open', [url]];
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'ignore' });
  if (r.status !== 0) {
    console.warn(`(could not open browser automatically — open manually: ${url})`);
  }
}

async function findCiRunForTag(tag) {
  // gh run list returns most-recent first. We want the latest run on the
  // release.yml workflow whose displayTitle / headBranch matches our tag.
  // Tag-push runs have headBranch === <tag>; workflow_dispatch runs may
  // have headBranch === main with the tag in the input.
  const json = runCapture(
    `gh run list --workflow=${WORKFLOW_FILE} --limit=10 --json databaseId,headBranch,displayTitle,event,createdAt`
  );
  const runs = JSON.parse(json);
  const match = runs.find(
    (r) => r.headBranch === tag || r.displayTitle?.includes(tag),
  );
  return match ? String(match.databaseId) : null;
}

async function waitForRun(tag) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const id = await findCiRunForTag(tag);
    if (id) return id;
    await sleep(POLL_INTERVAL_MS);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  throw new Error(
    `Timed out waiting for a CI run on ${tag}. Check Actions tab manually.`
  );
}

// ----- main -----

const bump = process.argv[2] || 'patch';
if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Unknown bump: ${bump}. Use patch / minor / major.`);
  process.exit(1);
}

step(`Bumping version (${bump})…`);
run(`npm version ${bump}`);
const tag = `v${pkgVersion()}`;
console.log(`Tagged ${tag}.`);

step('Pushing tag…');
run('git push --follow-tags');

step(`Waiting for CI run on ${tag}…`);
console.log(`Sleeping ${PRE_RUN_DELAY_MS / 1000}s to let GitHub register the push, then polling.`);
await sleep(PRE_RUN_DELAY_MS);
const runId = await waitForRun(tag);
console.log(`Found run ${runId}.`);

step('Watching CI to completion…');
run(`gh run watch ${runId} --exit-status`);

step(`Downloading vsix from release ${tag}…`);
mkdirSync(RELEASE_DIR, { recursive: true });
run(`gh release download ${tag} --pattern "*.vsix" -D ${RELEASE_DIR} --clobber`);

const downloaded = readdirSync(RELEASE_DIR).filter((n) => n.endsWith('.vsix'));
console.log(`✓ ${downloaded.length} file(s) in ./${RELEASE_DIR}/:`);
for (const f of downloaded) console.log(`   ${f}`);

step('Opening marketplace publisher dashboard…');
openInBrowser(PUBLISHER_URL);

console.log(`
Done. Drag ./${RELEASE_DIR}/${downloaded[0] || '*.vsix'} into the
"Update" dialog at:
  ${PUBLISHER_URL}
`);
