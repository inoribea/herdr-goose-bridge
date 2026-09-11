#!/usr/bin/env node
/**
 * goose-bridge startup hook.
 *
 * Herdr startup hooks are one-shot: they run once after the session is restored
 * and the API socket is ready, and they are explicitly NOT a place for
 * supervised daemons ("a hook should restore plugin-owned state, call any
 * required Herdr APIs, and exit"). So this hook does the only thing it should:
 * ask Herdr to open this plugin's long-lived watcher pane, then exit.
 *
 * Idempotent two ways, because a pane may already be open from any of:
 *   - the startup hook (normal path)
 *   - the "watch" action invoked by hand
 *   - a manual `herdr plugin pane open`
 * Guard 1: a live watcher PID in the plugin state dir.
 * Guard 2: a plugin pane whose label matches the manifest pane title.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const log = (...a) => console.log('[goose-bridge:autostart]', ...a);

const PLUGIN = 'goose.bridge';
const ENTRYPOINT = 'watcher';
const PANE_TITLE = 'goose bridge';
const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

function herdr(args) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', timeout: 15000 });
  return {
    status: r.status,
    out: (r.stdout || '').trim(),
    err: (r.stderr || '').trim(),
  };
}

function stateDirs() {
  const out = [];
  if (process.env.HERDR_PLUGIN_STATE_DIR) out.push(process.env.HERDR_PLUGIN_STATE_DIR);
  if (process.env.TEMP) out.push(process.env.TEMP);
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'herdr', 'plugins', PLUGIN));
  }
  return [...new Set(out)];
}

function liveWatcherPid() {
  for (const dir of stateDirs()) {
    const f = path.join(dir, 'goose-bridge-watcher.pid');
    try {
      const pid = Number.parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        process.kill(pid, 0); // throws if the process is gone
        return pid;
      }
    } catch {
      /* no pid file, or the process is gone */
    }
  }
  return 0;
}

function watcherPaneOpen() {
  const r = herdr(['pane', 'list']);
  if (r.status !== 0) return false;
  let panes = [];
  try {
    const j = JSON.parse(r.out);
    panes = j?.result?.panes || j?.panes || [];
  } catch {
    return false;
  }
  return panes.some(
    (p) => String(p?.label || '').toLowerCase() === PANE_TITLE.toLowerCase()
  );
}

// Never fail Herdr startup.
try {
  const pid = liveWatcherPid();
  if (pid && watcherPaneOpen()) {
    log(`watcher already running (pid ${pid}); nothing to do`);
    process.exit(0);
  }
  if (pid) {
    log(`watcher pid ${pid} alive but its pane is gone; reopening`);
  } else if (watcherPaneOpen()) {
    log('watcher pane already open; nothing to do');
    process.exit(0);
  }

  const r = herdr([
    'plugin',
    'pane',
    'open',
    '--plugin',
    PLUGIN,
    '--entrypoint',
    ENTRYPOINT,
    '--placement',
    'tab',
    '--no-focus',
  ]);
  if (r.status === 0) {
    log('watcher pane open requested (tab, no focus)');
  } else {
    log(
      `could not open watcher pane (status ${r.status}):`,
      r.err || r.out
    );
  }
} catch (e) {
  log('unexpected error:', e.message);
}
process.exit(0);
