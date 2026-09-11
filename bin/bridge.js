#!/usr/bin/env node
/**
 * goose -> Herdr state bridge
 *
 * Long-lived watcher. Runs *as a Herdr plugin pane* (declared [[panes]] in
 * herdr-plugin.toml), because Herdr startup hooks are one-shot and explicitly
 * not meant for supervised daemons. bin/autostart.js opens this pane.
 *
 * It reports lifecycle state for every pane whose foreground program is goose:
 *
 *   herdr pane report-agent <PANE_ID> --source <SOURCE> --agent <LABEL> \
 *        --state <idle|working|blocked|unknown> [--message TEXT] [--seq N]
 *
 * It never sends input to a pane and never writes files outside its own state
 * dir. Read-only + state reporting.
 *
 * Detection (in order):
 *   1. foreground process identity from `pane process-info` (name/argv0/argv[0])
 *   2. goose OSC title on the pane + goose screen markers
 *      — required on Windows: goose is a line-mode CLI, its process does not
 *        appear in process-info (verified 2026-09-11: while a goose session was
 *        live, foreground_processes still listed only powershell.exe), but
 *        terminal_title becomes "🪿 goose".
 *   3. pane-record fields (legacy), optional cmdline match, optional full scan.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOG = '[goose-bridge]';
const log = (...a) => console.log(LOG, ...a);
const warn = (...a) => console.warn(LOG, ...a);

function num(v, d) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}

function compileList(s) {
  return (s || '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      try {
        return new RegExp(x, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const CFG = {
  pollMs: num(process.env.GOOSE_BRIDGE_POLL_MS, 2000),
  idleAfterMs: num(process.env.GOOSE_BRIDGE_IDLE_AFTER_MS, 6000),
  lines: num(process.env.GOOSE_BRIDGE_LINES, 30),
  source: process.env.GOOSE_BRIDGE_SOURCE || 'custom:goose',
  agentLabel: process.env.GOOSE_BRIDGE_AGENT || 'goose',
  // basename of the foreground process must match this
  procPattern:
    process.env.GOOSE_BRIDGE_PROC || '^(goose|goose\\.exe|goosed|goosed\\.exe)$',
  // pane title pattern. ON by default: on Windows goose never shows up in
  // process-info, only in the pane title.
  titlePattern: process.env.GOOSE_BRIDGE_TITLE || 'goose',
  // screen markers required for a title-only match, so a stale title after
  // goose exits releases the pane instead of lying forever
  screenPattern:
    process.env.GOOSE_BRIDGE_SCREEN_PATTERN ||
    'goose is ready|Enter to send|Ctrl\\+J newline|\\( ?O\\)>',
  // read the screen of every pane, not only title matches (costly; off)
  screenAlways: process.env.GOOSE_BRIDGE_SCREEN === '1',
  // pane record keys that may hold the foreground *program* (secondary source,
  // used only when process-info is unavailable). Deliberately excludes label
  // fields (`agent`, `name`, `title`): herdr echoes the last reported agent name
  // in `agent`, so leaving it here makes a pane match itself forever.
  paneFields: (
    process.env.GOOSE_BRIDGE_PANE_FIELDS ||
    'foreground_command,foreground_process,command,process,program,executable,argv0'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  forcePanes: (process.env.GOOSE_BRIDGE_PANES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  blocked: compileList(
    process.env.GOOSE_BRIDGE_BLOCKED ||
      'allow\\?|approve|permission|\\[y/N\\]|\\(y/n\\)|press enter|enter to continue|waiting for (your )?input|continue\\?'
  ),
  blockedDebounceMs: num(process.env.GOOSE_BRIDGE_BLOCKED_DEBOUNCE_MS, 1500),
  dryRun: process.argv.includes('--dry-run'),
};

const reCache = new Map();
function re(pat) {
  if (!reCache.has(pat)) reCache.set(pat, new RegExp(pat, 'i'));
  return reCache.get(pat);
}

// ------------------------------------------------------------------- pidfile

const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR || process.env.TEMP || process.cwd();
const PID_FILE = path.join(STATE_DIR, 'goose-bridge-watcher.pid');

function writePidFile() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* non-fatal */
  }
}

function removePidFile() {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* non-fatal */
  }
}

// ---------------------------------------------------------------- herdr CLI

function resolveHerdr() {
  if (process.env.HERDR_BIN_PATH) return process.env.HERDR_BIN_PATH;
  const probe = spawnSync('herdr', ['--version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'herdr';
  return null;
}

let HERDR = null;

function herdr(args, { json = false } = {}) {
  const r = spawnSync(HERDR, args, { encoding: 'utf8', timeout: 15000 });
  if (r.error) throw new Error(`${args.join(' ')}: ${r.error.message}`);
  const out = (r.stdout || '').trim();
  if (r.status !== 0) {
    throw new Error(
      `${args.join(' ')} failed (${r.status}): ${(r.stderr || '').trim() || out}`
    );
  }
  if (!json) return out;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`non-JSON output from "${args.join(' ')}": ${out.slice(0, 200)}`);
  }
}

function normPanes(raw) {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.result?.panes)
      ? raw.result.panes
      : Array.isArray(raw?.panes)
        ? raw.panes
        : Array.isArray(raw?.data)
          ? raw.data
          : Array.isArray(raw?.result)
            ? raw.result
            : [];
  return arr
    .map((p) => ({ id: p?.pane_id || p?.paneId || p?.id, raw: p }))
    .filter((p) => typeof p.id === 'string' && p.id.length > 0);
}

function basenameLike(s) {
  return String(s).split(/[\\/]/).pop() || String(s);
}

function candidates(pane) {
  const out = [];
  for (const k of CFG.paneFields) {
    const v = pane?.raw?.[k];
    if (v == null) continue;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) out.push(...v.map(String));
    else if (typeof v === 'object') {
      for (const vv of Object.values(v)) if (typeof vv === 'string') out.push(vv);
    }
  }
  return out;
}

// `herdr pane process-info --pane <id>` is the authoritative source for the
// foreground program. Only *process identity* fields are inspected: name,
// argv0 and argv[0]. NEVER cmdline/cwd — a pane whose cwd is `...\goose\` makes
// basenameLike() return "goose" and matched `^goose$` (observed live on
// 2026-09-11; false positive fixed here).
function procInfoOf(raw) {
  const info = raw?.result?.process_info || raw?.process_info || {};
  const list = Array.isArray(info.foreground_processes)
    ? info.foreground_processes
    : [];
  const ids = [];
  const cmdlines = [];
  for (const p of list) {
    if (typeof p?.name === 'string' && p.name) ids.push(p.name);
    if (typeof p?.argv0 === 'string' && p.argv0) ids.push(p.argv0);
    if (Array.isArray(p?.argv) && typeof p.argv[0] === 'string') ids.push(p.argv[0]);
    if (typeof p?.cmdline === 'string' && p.cmdline) cmdlines.push(p.cmdline);
  }
  return { ids, cmdlines };
}

function foregroundProbe(paneId) {
  try {
    return procInfoOf(JSON.parse(herdr(['pane', 'process-info', '--pane', paneId])));
  } catch {
    return { ids: [], cmdlines: [] };
  }
}

function matchesProcName(s) {
  return re(CFG.procPattern).test(basenameLike(s));
}

function foregroundIsGoose(paneId) {
  const { ids, cmdlines } = foregroundProbe(paneId);
  if (ids.some(matchesProcName)) return true;
  // Opt-in: goose may be launched through a wrapper (node.exe cli.js, npx …),
  // in which case the process identity never says "goose" but the command line
  // does. Off by default because cmdlines embed paths (same cwd trap).
  if (process.env.GOOSE_BRIDGE_MATCH_CMDLINE === '1') {
    if (cmdlines.some((c) => re(CFG.procPattern).test(c))) return true;
  }
  return false;
}

function titleOf(pane) {
  return pane?.raw?.terminal_title || pane?.raw?.title || pane?.raw?.name || '';
}

function screenIsGoose(text) {
  return text != null && re(CFG.screenPattern).test(text);
}

// getText is a lazy reader (() => string|null); only called when needed.
function isGoose(pane, getText) {
  if (CFG.forcePanes.length) return CFG.forcePanes.includes(pane.id);
  if (foregroundIsGoose(pane.id)) return true;
  for (const c of candidates(pane)) {
    if (re(CFG.procPattern).test(basenameLike(c))) return true;
  }
  const t = titleOf(pane);
  const titleHit = !!(CFG.titlePattern && t && re(CFG.titlePattern).test(t));
  if (titleHit || CFG.screenAlways) {
    const text = getText ? getText() : null;
    if (text == null) return titleHit;
    return screenIsGoose(text);
  }
  return false;
}

function readPane(id) {
  return herdr(['pane', 'read', id, '--source', 'recent', '--lines', String(CFG.lines)]);
}

function report(paneId, state, seq, message) {
  const args = [
    'pane',
    'report-agent',
    paneId,
    '--source',
    CFG.source,
    '--agent',
    CFG.agentLabel,
    '--state',
    state,
    '--seq',
    String(seq),
  ];
  if (message) args.push('--message', message);
  if (CFG.dryRun) {
    log('[dry-run]', args.join(' '));
    return;
  }
  herdr(args);
}

function release(paneId) {
  const args = [
    'pane',
    'release-agent',
    paneId,
    '--source',
    CFG.source,
    '--agent',
    CFG.agentLabel,
  ];
  if (CFG.dryRun) {
    log('[dry-run]', args.join(' '));
    return;
  }
  herdr(args);
}

// ------------------------------------------------------------------- state

const track = new Map(); // paneId -> {hash, since, state, seq, lastBlocked}

function tailLines(text, n) {
  return text.split(/\r?\n/).slice(-n).join('\n');
}

function classify(paneId, preloaded) {
  let text = preloaded;
  if (text == null) {
    try {
      text = readPane(paneId);
    } catch (e) {
      return null;
    }
  }
  const st =
    track.get(paneId) ||
    {
      hash: '',
      since: Date.now(),
      state: '',
      seq: 0,
      lastBlocked: 0,
      primed: false,
      changes: 0,
    };
  const h = crypto.createHash('sha1').update(text).digest('hex');
  if (h !== st.hash) {
    // The first observation is a baseline, not a change: there is nothing to
    // compare it against yet, so it must not count as activity.
    if (st.primed) {
      st.changes += 1;
    } else {
      st.primed = true;
      log(`${paneId}: first sight, waiting for the screen to settle before guessing`);
    }
    st.hash = h;
    st.since = Date.now();
  }
  const quietFor = Date.now() - st.since;

  // Verified live 2026-09-11: classifying a freshly seen pane as `working`
  // because quietFor starts at 0 put a false "working" badge on panes that had
  // been idle all along — a restored goose pane flashed working for the whole
  // quiet window after every restart. Until something has actually changed there
  // is no evidence either way, so report nothing and let the quiet window decide.
  let state = quietFor >= CFG.idleAfterMs ? 'idle' : 'working';
  if (!st.changes && quietFor < CFG.idleAfterMs) state = null;
  let message = null;

  const tail = tailLines(text, 12);
  if (quietFor >= CFG.blockedDebounceMs) {
    for (const r of CFG.blocked) {
      if (r.test(tail)) {
        state = 'blocked';
        const line = tail.split(/\r?\n/).filter((l) => r.test(l)).pop() || '';
        message = line.trim().slice(0, 120) || 'goose may be waiting for input';
        st.lastBlocked = Date.now();
        break;
      }
    }
  }

  track.set(paneId, st);
  return { st, state, message };
}

let shuttingDown = false;

function tick() {
  if (shuttingDown) return;
  let panes;
  try {
    panes = normPanes(herdr(['pane', 'list'], { json: true }));
  } catch (e) {
    warn('pane list failed:', e.message);
    return;
  }

  const cache = new Map();
  const textFor = (id) => {
    if (!cache.has(id)) {
      try {
        cache.set(id, readPane(id));
      } catch {
        cache.set(id, null);
      }
    }
    return cache.get(id);
  };

  const seen = new Set();
  for (const pane of panes) {
    // never watch our own watcher pane
    if (process.env.HERDR_PANE_ID && pane.id === process.env.HERDR_PANE_ID) continue;
    if (!isGoose(pane, () => textFor(pane.id))) continue;
    seen.add(pane.id);
    const r = classify(pane.id, textFor(pane.id));
    if (!r) continue;
    const { st, state, message } = r;
    // null = nothing observed yet; classify() knows when it has grounds to speak
    if (!state) continue;
    if (state === st.state) continue;
    const prev = st.state || '(none)';
    // Monotonic across restarts. herdr keeps a per-(pane,source,agent)
    // high-water mark for --seq and silently ignores anything <= it — verified
    // live 2026-09-11: report(working,100) applied, release-agent, then
    // report(idle,50) was ignored (pane stayed working). A counter starting at
    // 1 after a bridge restart would therefore be dropped forever.
    // A millisecond timestamp is monotonic by construction (1.7e15 < 2^53).
    st.seq = Math.max(st.seq + 1, Date.now() * 1000);
    try {
      report(pane.id, state, st.seq, state === 'blocked' ? message : undefined);
      st.state = state;
      log(`${pane.id}: ${prev} -> ${state}${message ? ` (${message})` : ''}`);
    } catch (e) {
      warn(`report ${pane.id} failed:`, e.message);
    }
  }

  for (const id of [...track.keys()]) {
    if (!seen.has(id)) {
      try {
        release(id);
        log(`${id}: released (pane gone or no longer goose)`);
      } catch (e) {
        // A pane that closed takes its authority with it; that is not an error.
        if (/pane_not_found/.test(e.message)) {
          log(`${id}: gone (nothing to release)`);
        } else {
          warn(`release ${id} failed:`, e.message);
        }
      }
      track.delete(id);
    }
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  removePidFile();
  for (const id of track.keys()) {
    try {
      release(id);
    } catch {
      /* best effort */
    }
  }
  process.exit(0);
}

// ------------------------------------------------------------------- main

function main() {
  HERDR = resolveHerdr();
  if (!HERDR) {
    log('no herdr binary found (set HERDR_BIN_PATH); nothing to do');
    process.exit(0);
  }

  if (CFG.dryRun) {
    log('herdr:', HERDR);
    log('config:', JSON.stringify({ ...CFG, blocked: CFG.blocked.map(String) }));
    try {
      const panes = normPanes(herdr(['pane', 'list'], { json: true }));
      log(`panes: ${panes.length}`);
      for (const p of panes) {
        let text = null;
        try {
          text = readPane(p.id);
        } catch {
          /* ignore */
        }
        const probe = foregroundProbe(p.id);
        log(
          `  ${p.id} goose=${isGoose(p, () => text)} title=${JSON.stringify(titleOf(p))} screen=${screenIsGoose(text)}`
        );
        log(`    foreground=${JSON.stringify(probe.ids)}`);
      }
    } catch (e) {
      warn('dry run failed:', e.message);
    }
    process.exit(0);
  }

  writePidFile();
  log(`watching (poll ${CFG.pollMs}ms, source ${CFG.source}, agent ${CFG.agentLabel})`);
  log(`state dir ${STATE_DIR}`);
  log(`own pane ${process.env.HERDR_PANE_ID || '(none)'}`);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);

  tick();
  setInterval(tick, CFG.pollMs);
}

main();
