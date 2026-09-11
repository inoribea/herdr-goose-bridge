#!/usr/bin/env node
/**
 * Dependency-free static checks for this repository.
 *
 *   npm run verify
 *
 * Needs no herdr, no network and no `npm install`. It asserts the invariants
 * this repo actually paid for (each one is backed by docs/FINDINGS.md):
 *
 *   1. herdr-plugin.toml has the shape herdr plugin v1 requires.
 *   2. Every path a manifest command points at exists.
 *   3. The long-lived watcher is a [[panes]] entrypoint, never a [[startup]]
 *      hook: startup hooks are one-shot and must exit.
 *   4. herdr-plugin.toml and package.json agree on the version.
 *   5. Detection never matches a pane-record `agent` field, which makes a pane
 *      match itself forever (a real bug that shipped once).
 *   6. Reports use a monotonic, timestamp-derived `--seq`: herdr keeps a
 *      persistent per-(pane, source, agent) high-water mark and silently drops
 *      anything at or below it, so a counter restarting at 1 is lost forever.
 *   7. The startup hook proves a pane is running the watcher before believing
 *      a pane title: herdr restores a plugin pane as a plain shell wearing the
 *      same title, which shipped as "watcher already open" and a dead bridge.
 *   8. The default title pattern carries goose's own emoji: goose titles its
 *      pane with that emoji plus the directory name, so a pattern of just
 *      "goose" only ever matched sessions running in a directory called goose.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push(['ok', name]);
  } catch (error) {
    results.push(['FAIL', `${name} — ${error.message}`]);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Split the manifest into the root table plus each [[block]], keeping raw lines. */
function parseManifest(text) {
  const blocks = [{ header: '', body: [] }];
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      blocks.push({ header: header[1].trim(), body: [] });
      continue;
    }
    blocks[blocks.length - 1].body.push(line);
  }
  return blocks;
}

function valueOf(body, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)${'\\s*$'}`);
  for (const line of body) {
    const match = pattern.exec(line.replace(/\s+#.*$/, ''));
    if (match) return match[1].replace(/^"(.*)"$/, '$1').replace(/^\[(.*)\]$/, '$1');
  }
  return null;
}

function commandOf(body) {
  const match = /^\s*command\s*=\s*\[([^\]]*)\]/m.exec(body.join('\n'));
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

const MANIFEST = 'herdr-plugin.toml';
const BRIDGE = 'bin/bridge.js';
const manifestText = read(MANIFEST);
const blocks = parseManifest(manifestText);
const byHeader = (header) => blocks.filter((block) => block.header === header);

check('manifest: required root keys', () => {
  for (const key of ['id', 'name', 'version', 'min_herdr_version', 'description', 'platforms']) {
    assert(valueOf(blocks[0].body, key), `missing root key "${key}"`);
  }
});

check('manifest: every referenced path exists', () => {
  for (const block of blocks.slice(1)) {
    for (const arg of commandOf(block.body) || []) {
      if (arg === 'node' || arg.startsWith('-')) continue;
      assert(existsSync(join(ROOT, arg)), `[[${block.header}]] command points at missing file "${arg}"`);
    }
  }
});

check('manifest: the watcher is a [[panes]] entrypoint', () => {
  const panes = byHeader('panes');
  assert(panes.length >= 1, 'no [[panes]] block');
  assert(
    panes.some((pane) => valueOf(pane.body, 'id') === 'watcher'),
    'no [[panes]] block with id = "watcher"',
  );
});

check('manifest: startup hooks stay one-shot', () => {
  for (const block of byHeader('startup')) {
    assert(
      !(commandOf(block.body) || []).includes(BRIDGE),
      `a [[startup]] hook runs ${BRIDGE}; startup hooks must restore state and exit`,
    );
  }
});

check('manifest: version matches package.json', () => {
  const manifestVersion = valueOf(blocks[0].body, 'version');
  const packageVersion = JSON.parse(read('package.json')).version;
  assert(
    packageVersion === manifestVersion,
    `package.json is ${packageVersion}, ${MANIFEST} is ${manifestVersion}`,
  );
});

check('detection: pane-record "agent" field is never matched', () => {
  const source = read(BRIDGE);
  const list = /GOOSE_BRIDGE_PANE_FIELDS\s*\|\|\s*'([^']+)'/.exec(source);
  assert(list, `could not find the default pane-field list in ${BRIDGE}`);
  const fields = list[1].split(',').map((field) => field.trim());
  for (const echoed of ['agent', 'agent_status', 'title', 'label']) {
    assert(
      !fields.includes(echoed),
      `the default pane fields include "${echoed}"; herdr echoes the last reported agent back into it, so a pane would match itself forever`,
    );
  }
});

check('reports: the sequence is monotonic and derived from the clock', () => {
  const source = read(BRIDGE);
  assert(
    /Date\.now\(\)\s*\*\s*1000/.test(source),
    `${BRIDGE} no longer derives --seq from Date.now(); herdr drops any sequence at or below its stored high-water mark`,
  );
});

check('reports: panes are only ever reported, never driven', () => {
  for (const file of ['bin/bridge.js', 'bin/autostart.js', 'bin/release-all.js']) {
    const source = read(file);
    for (const forbidden of ['send-text', 'send-keys']) {
      assert(
        !new RegExp(`['"]${forbidden}['"]`).test(source),
        `${file} calls the pane input API "${forbidden}"; this bridge is read-only plus state reports`,
      );
    }
  }
});

check('autostart: a pane title is not proof that the watcher is running', () => {
  const source = read('bin/autostart.js');
  assert(
    /process-info/.test(source),
    'bin/autostart.js never asks `pane process-info`; a restored plugin pane wears the same title as a live one, so the title alone reports a dead bridge as running',
  );
  assert(
    /foreground_processes/.test(source),
    'bin/autostart.js does not read foreground_processes; that is the only field that says what a pane actually runs',
  );
  assert(
    /PLUGIN_ROOT/.test(source) && /'close'/.test(source),
    'bin/autostart.js closes leftover panes without a plugin-root check; it would close any pane that happens to wear the title',
  );
});

check('detection: the default title pattern carries goose\'s own marker', () => {
  const source = read(BRIDGE);
  const pattern = /GOOSE_BRIDGE_TITLE\s*\|\|\s*'((?:[^'\\]|\\.)*)'/.exec(source);
  assert(pattern, `could not find the default GOOSE_BRIDGE_TITLE in ${BRIDGE}`);
  assert(
    /1FABF|🪿/.test(pattern[1]),
    `the default title pattern is "${pattern[1]}"; goose titles its pane "\u{1FABF} <directory>", so a pattern without the emoji only matches sessions that happen to run in a directory named goose`,
  );
});

const failed = results.filter(([, status]) => status.startsWith('FAIL'));
for (const [status, name] of results) console.log(`${status.padEnd(4)} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
