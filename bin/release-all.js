#!/usr/bin/env node
/**
 * Release goose state authority for every pane this bridge currently owns.
 * Invoke from the Herdr UI (plugin action) or manually:
 *
 *   node bin/release-all.js
 */
'use strict';

const { spawnSync } = require('node:child_process');

const SOURCE = process.env.GOOSE_BRIDGE_SOURCE || 'custom:goose';
const AGENT = process.env.GOOSE_BRIDGE_AGENT || 'goose';
const DRY = process.argv.includes('--dry-run');
const LOG = '[goose-bridge]';

function herdrBin() {
  if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;
  const p = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
  return p.status === 0 ? 'herdr' : null;
}

function main() {
  const bin = herdrBin();
  if (!bin) {
    console.log(LOG, 'no herdr binary found (set HERDR_BIN_PATH); nothing to do');
    process.exit(0);
  }
  const list = spawnSync(bin, ['pane', 'list'], { encoding: 'utf8', timeout: 15000 });
  if (list.status !== 0) {
    console.error(LOG, 'pane list failed:', (list.stderr || '').trim());
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(list.stdout);
  } catch {
    console.error(LOG, 'pane list did not return JSON; nothing released');
    process.exit(1);
  }
  const panes = Array.isArray(raw)
    ? raw
    : raw?.result?.panes || raw?.panes || raw?.data || raw?.result || [];
  let n = 0;
  for (const p of panes) {
    const id = p?.pane_id || p?.paneId || p?.id;
    if (typeof id !== 'string') continue;
    const args = ['pane', 'release-agent', id, '--source', SOURCE, '--agent', AGENT];
    if (DRY) {
      console.log(LOG, '[dry-run]', args.join(' '));
    } else {
      const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
      if (r.status === 0) {
        console.log(LOG, 'released', id);
        n += 1;
      } else {
        console.log(LOG, 'skip', id, (r.stderr || '').trim().slice(0, 120));
      }
    }
  }
  console.log(LOG, `done (${n} released)`);
}

main();
