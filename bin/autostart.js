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
 * Guard 2: a pane titled `goose bridge` whose foreground process is the watcher
 *          itself. A title alone is not proof. Herdr restores the previous
 *          session's panes before the startup hooks run, and a restored plugin
 *          pane comes back as a plain shell in the plugin directory: same title,
 *          same cwd, no watcher (docs/FINDINGS.md §11). Trusting that title left
 *          the bridge dead for a whole session, so the guard now asks
 *          `pane process-info`, closes the leftover, and opens a fresh pane.
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
// bin/autostart.js sits one level below the plugin root. HERDR_PLUGIN_ROOT is
// set when herdr runs this hook; the fallback keeps the script runnable by hand,
// which the manifest promises.
const PLUGIN_ROOT = path.resolve(
  process.env.HERDR_PLUGIN_ROOT || path.join(__dirname, '..')
);
// What a working watcher pane runs, and what a leftover shell does not.
const WATCHER_PROC = /^node(\.exe)?$/i;

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

function paneList() {
  const r = herdr(['pane', 'list']);
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.out);
    const panes = j?.result?.panes || j?.panes || j?.data;
    return Array.isArray(panes) ? panes : null;
  } catch {
    return null;
  }
}

function paneIdOf(pane) {
  const id = pane?.pane_id || pane?.paneId || pane?.id;
  return typeof id === 'string' && id ? id : null;
}

// The pane record says what the plugin asked for; `process-info` says what is
// actually running. Only the second one is evidence.
const wearsPaneTitle = (pane) =>
  String(pane?.label || '').toLowerCase() === PANE_TITLE.toLowerCase();

const base = (s) => String(s).split(/[\\/]/).pop() || String(s);

/**
 *   true  — the watcher runs in this pane
 *   false — it does not
 *   null  — no answer (process-info unavailable); nothing is assumed either way
 */
function paneRunsWatcher(paneId) {
  const r = herdr(['pane', 'process-info', '--pane', paneId]);
  if (r.status !== 0) return null;
  let procs;
  try {
    const j = JSON.parse(r.out);
    const info = j?.result?.process_info || j?.process_info || {};
    procs = Array.isArray(info.foreground_processes) ? info.foreground_processes : [];
  } catch {
    return null;
  }
  for (const p of procs) {
    const names = [p?.name, p?.argv0];
    if (Array.isArray(p?.argv) && typeof p.argv[0] === 'string') names.push(p.argv[0]);
    if (names.some((n) => typeof n === 'string' && WATCHER_PROC.test(base(n)))) {
      return true;
    }
  }
  return false;
}

function sameDir(a, b) {
  if (typeof a !== 'string' || !a) return false;
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Split the panes wearing the watcher's title into the ones actually running
 * the watcher, the leftovers herdr restored as shells, and the ones this hook
 * has no business touching.
 */
function classify(panes) {
  const live = [];
  const leftovers = [];
  const untouched = [];
  for (const pane of panes) {
    if (!wearsPaneTitle(pane)) continue;
    const id = paneIdOf(pane);
    if (!id) continue;
    const running = paneRunsWatcher(id);
    if (running === true) live.push(id);
    else if (running === null) untouched.push(`${id} (process-info unavailable)`);
    else if (sameDir(pane.cwd, PLUGIN_ROOT)) leftovers.push(id);
    else untouched.push(`${id} (another cwd: ${pane.cwd || 'unknown'})`);
  }
  return { live, leftovers, untouched };
}

// Never fail Herdr startup.
try {
  const panes = paneList();
  const pid = liveWatcherPid();
  let open = true;

  if (!panes) {
    // Nothing to reason about; a live pid is still a live watcher.
    if (pid) {
      log(`pane list unavailable; watcher pid ${pid} is alive; nothing to do`);
      open = false;
    } else {
      log('pane list unavailable; opening a watcher pane anyway');
    }
  } else {
    const { live, leftovers, untouched } = classify(panes);
    for (const note of untouched) log(`leaving ${note} alone`);
    for (const id of leftovers) {
      const r = herdr(['pane', 'close', id]);
      if (r.status === 0) {
        log(`closed leftover pane ${id} (wears the pane title, runs no watcher)`);
      } else {
        log(`could not close leftover pane ${id}:`, r.err || r.out);
      }
    }
    if (live.length) {
      log(`watcher already running in ${live.join(', ')}; nothing to do`);
      open = false;
    } else if (pid) {
      log(`watcher pid ${pid} is alive but no pane is running it; opening a fresh pane`);
    }
  }

  if (open) {
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
      log(`could not open watcher pane (status ${r.status}):`, r.err || r.out);
    }
  }
} catch (e) {
  log('unexpected error:', e.message);
}
process.exit(0);
