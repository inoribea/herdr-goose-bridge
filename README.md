# goose-bridge — a Herdr plugin that gives goose panes real agent state

<p align="center">
  <img src="assets/cover.svg" alt="A goose pane is recognised by the goose bridge watcher pane, which reports idle, working or blocked to Herdr" width="880">
</p>

Herdr cannot detect goose on its own: goose is a line-mode CLI, so on Windows the
foreground process of a goose pane is still `powershell.exe` (verified — see
[docs/FINDINGS.md](docs/FINDINGS.md)). Herdr's own "supported agents" list therefore has no
goose entry, and goose panes stay `unknown`.

This plugin closes that gap without touching either program: it watches panes,
recognises goose, and reports `idle` / `working` / `blocked` through the supported
`herdr pane report-agent` API. It never sends input to a pane.

```
pane list before:  {"pane_id":"w1:p3","agent_status":"unknown", ...}
pane list after:   {"pane_id":"w1:p3","agent":"goose","agent_status":"done", ...}
```

Install: `herdr plugin install inoribea/herdr-goose-bridge` — the plugin is
listed on the [Herdr plugin marketplace](https://herdr.dev/plugins/). What that
does, and what to do on a machine that linked its own checkout, is under
[Install](#install).

## How it recognises goose

1. **Foreground process** (`herdr pane process-info`): `name` / `argv0` / `argv[0]`
   basename matched against `GOOSE_BRIDGE_PROC`. Catches full-screen agents.
2. **Title + screen** (the path that actually works for goose today): the pane
   title matches `GOOSE_BRIDGE_TITLE` (`goose` → `🪿 goose`) **and** the screen
   contains goose's UI markers (`goose is ready`, `Enter to send`, `(O)>` …).
   Two factors on purpose: when goose exits, its title may linger but the screen
   goes back to a shell prompt, so the pane gets released instead of lying.
3. Pane-record fields, optional cmdline match (`GOOSE_BRIDGE_MATCH_CMDLINE=1`),
   optional scan-every-pane (`GOOSE_BRIDGE_SCREEN=1`).

State is inferred from the pane output: changing output = `working`, quiet for
`GOOSE_BRIDGE_IDLE_AFTER_MS` = `idle`, and a prompt-looking tail
(`allow?`, `approve`, `permission`, `[y/N]`, `press enter` …) = `blocked`.

The first time a pane is seen, its output is only a baseline, so nothing is
reported until the screen either changes or stays quiet for the whole idle
window. Without that rule every newly seen pane announced `working` for the
length of the quiet window, including panes that had been idle all along.

## Layout

| File | Role |
| --- | --- |
| `herdr-plugin.toml` | manifest: 1 startup hook, 1 pane entrypoint, 3 actions |
| `bin/autostart.js` | startup hook — opens the watcher pane, then exits (idempotent) |
| `bin/bridge.js` | the long-lived watcher, runs *as a plugin pane* |
| `bin/release-all.js` | release goose authority on every pane (cleanup) |
| `docs/FINDINGS.md` | every claim above, with the command and output that proved it |
| `scripts/verify.mjs` | static checks for the invariants above (`npm run verify`) |

Herdr startup hooks are one-shot and explicitly not meant for daemons, so the
hook only opens the pane; `[[panes]] watcher` is the daemon.

## Requirements

- Herdr ≥ 0.9.0 (built and verified against 0.9.0, protocol 22)
- Node ≥ 22 (verified on v24; the plugin calls the `herdr` binary through
  `HERDR_BIN_PATH`, so no herdr libraries are needed)
- `git` on `PATH` for `herdr plugin install`, which clones the repository
## Install

Two ways in: from the marketplace, or from a checkout you are editing. Herdr
will not let one machine have both at once ([below](#switching-between-the-two)).

### From the marketplace

```powershell
herdr plugin install inoribea/herdr-goose-bridge
```

`plugin install` takes GitHub shorthand only (`owner/repo[/subdir...]`), clones
with `git`, and prints the manifest it is about to register, including every
command it will run:

```
Plugin install preview:
  id: goose.bridge
  name: goose state bridge
  version: 0.2.1
  source: inoribea/herdr-goose-bridge
  commit: 6390d8409e8a93c9bfdf61fccc68165c361ab8c9
  actions: 3
  startup commands: 1
  events: 0
  panes: 1
  link handlers: 0
  build commands: 0
    startup: node bin/autostart.js
    action probe: node bin/bridge.js --dry-run
    action release: node bin/release-all.js
    action watch: node bin/autostart.js
    pane watcher: node bin/bridge.js
```

Add `--yes` for a non-interactive install (the preview is printed either way),
or `--ref <commit|tag>` to pin a revision. The manifest declares no build
commands, so nothing is installed with npm, and the plugin is registered
enabled. `herdr plugin list` then reports the resolved commit, not the ref that
was asked for:

```
- goose.bridge (goose state bridge) enabled [github:inoribea/herdr-goose-bridge@6390d8409e8a93c9bfdf61fccc68165c361ab8c9]
```

The clone lands in Herdr's plugin data; `herdr plugin config-dir goose.bridge`
prints the config directory next to it, and `HERDR_PLUGIN_ROOT` /
`HERDR_PLUGIN_CONFIG_DIR` hold the same two things inside a plugin command.
Herdr refuses an install whose `min_herdr_version` is newer than the running
binary, so a Herdr below 0.9.0 rejects this plugin instead of half-installing it.

### From a checkout (development)

```powershell
herdr plugin link C:\path\to\herdr-goose-bridge
herdr plugin list    # → goose.bridge enabled [local:C:\path\to\herdr-goose-bridge]
```

`plugin link` registers the working directory in place: no clone, no build
commands.

### Switching between the two

Herdr refuses a GitHub install over a plugin that is linked from a local path,
and the message names the reason:

```
Error: Custom { kind: Other, error: "plugin goose.bridge is already linked from a local path; uninstall/unlink it before installing from GitHub" }
```

So a machine that linked its own checkout reaches the marketplace install through
`herdr plugin unlink goose.bridge` — and that step needs a running Herdr
**server**, unlike `plugin install` and `plugin link`, which both register while
no server is running. `herdr plugin uninstall <id-or-source>` instead removes the
managed checkout too.

### Start it

The startup hook runs on the next Herdr server start, so a freshly registered
plugin needs one kick. These need a running server:

```powershell
herdr plugin action invoke goose.bridge.watch
# or from the UI: plugin action "goose bridge: open the watcher tab"
# or directly:
herdr plugin pane open --plugin goose.bridge --entrypoint watcher --placement tab --no-focus
```

The watcher then lives in a tab titled **goose bridge** and prints its state
transitions there. Herdr also keeps the startup hook's own stdout, in
`herdr plugin log list` — that is where a hook that decided not to open the pane
says so, and how the failure in
[docs/FINDINGS.md §11](docs/FINDINGS.md) was caught.

**A restart restores the pane as a shell, not as the watcher.** Herdr brings the
previous session's panes back before the startup hooks run, and a restored plugin
pane is a plain shell sitting in the plugin directory: `session.json` still
records `launch_argv`, but nothing re-runs it, while the pane title survives. The
hook therefore never trusts a title: it asks `pane process-info`, closes a pane
that wears the title inside the plugin root without running `node`, and opens a
real watcher pane. Without that check the hook reported "watcher pane already
open; nothing to do" on every start and the bridge stayed dead all session.

### Update / remove

There is no `plugin update` in plugin v1: reinstall from GitHub to refresh the
managed checkout.

```powershell
herdr plugin install inoribea/herdr-goose-bridge --yes   # update in place
herdr plugin uninstall inoribea/herdr-goose-bridge       # remove (the id works too)
```

### Dry run, release and cleanup

The manifest's actions call the same scripts, so no path or checkout layout is
needed — only a running server:

```powershell
herdr plugin action invoke goose.bridge.probe     # dry run: print what it sees
herdr plugin action invoke goose.bridge.release   # release goose state on every pane
```

In a checkout the scripts still run standalone, no herdr and no server required:

```powershell
node bin\bridge.js --dry-run
node bin\release-all.js
npm run check     # node --check on every script + the invariant checks
```

The install, the refusal and the unlink error above are replayed outputs, in
[docs/FINDINGS.md §10](docs/FINDINGS.md); `--ref` pinning is documented, not
replayed.
## Configuration (environment)

Set these on the watcher pane (or in the shell that starts it).

| Var | Default | Meaning |
| --- | --- | --- |
| `GOOSE_BRIDGE_POLL_MS` | `2000` | poll interval |
| `GOOSE_BRIDGE_IDLE_AFTER_MS` | `6000` | quiet time before reporting `idle` |
| `GOOSE_BRIDGE_LINES` | `30` | screen lines read per poll |
| `GOOSE_BRIDGE_SOURCE` | `custom:goose` | `--source`; keep stable, it keys the seq watermark |
| `GOOSE_BRIDGE_AGENT` | `goose` | `--agent` label |
| `GOOSE_BRIDGE_PROC` | `^(goose\|goose\.exe\|goosed\|goosed\.exe)$` | basename regex for the foreground program |
| `GOOSE_BRIDGE_TITLE` | `goose` | pane-title regex (one of the two detection factors) |
| `GOOSE_BRIDGE_SCREEN_PATTERN` | `goose is ready\|Enter to send\|Ctrl\+J newline\|\( ?O\)>` | markers required for a title-only match |
| `GOOSE_BRIDGE_SCREEN` | `0` | `1` = read every pane's screen, not just title matches |
| `GOOSE_BRIDGE_MATCH_CMDLINE` | `0` | `1` = also match `process-info` cmdlines (wrapper launches) |
| `GOOSE_BRIDGE_PANES` | *(empty)* | force pane ids (debugging) |
| `GOOSE_BRIDGE_BLOCKED` | built-in set | `\|`-separated regexes that mean "waiting for input" |
| `GOOSE_BRIDGE_BLOCKED_DEBOUNCE_MS` | `1500` | don't call a prompt `blocked` too early |
| `GOOSE_BRIDGE_PANE_FIELDS` | `foreground_command,foreground_process,command,process,program,executable,argv0` | legacy pane-record fallback |

## Known limitations

- **State is heuristic.** `working` / `idle` come from an output hash + quiet
  timer; `blocked` is regex guessing. If goose's TUI keeps redrawing during a
  turn, `idle` may never trigger.
- **The watcher pane is reopened, not reattached.** Plugin v1 has no supervisor
  for plugin panes, so after a Herdr restart the hook closes the leftover pane
  and opens a fresh one. The new pane starts with no history of the states the
  previous watcher reported.
- **No native badge.** Plugin v1 excludes runtime action registration and native
  non-terminal UI, so this cannot become a first-class herdr integration with a
  session manifest. It is a bridge, not an integration.
- **`--seq` is sticky.** herdr ignores non-increasing `--seq` per
  (pane, source, agent) and `release-agent` does not reset it, hence the
  timestamp-based sequence. Never reuse `GOOSE_BRIDGE_SOURCE` for another agent.
- **`release-agent` does not clear the pane's displayed agent name.** Verified:
  the last known `agent` / `agent_status` stay on the pane, and there is no CLI
  command to clear them (`clear-agent-authority` is socket-only).
- **Windows multi-machine SSH is not covered** by anything here.
- Not a `herdr integration install` target: goose has no herdr screen manifest,
  which would be core work, not plugin work.

## Marketplace listing

This plugin is listed on [herdr.dev/plugins](https://herdr.dev/plugins/): a
repository card for `inoribea/herdr-goose-bridge` with a manifest row of
`goose state bridge` 0.2.1. Herdr's plugin marketplace indexes public GitHub
repositories that carry the topic `herdr-plugin` and at least one
`herdr-plugin.toml` with parseable required metadata on the default branch.
There is no submission form and no review queue: the index refreshes every 30
minutes, and a repository is rescanned when its default-branch head changes.
Forks and archived repositories are excluded. A card records the manifest path,
`id`, `name`, `version`, `platforms` and `min_herdr_version` together with the
exact default-branch commit it read
([how the index works](https://herdr.dev/docs/marketplace/)).

That refresh window is also the lag to expect after a push: `herdr plugin
install` clones the default-branch head immediately, while the listing catches
up on the next refresh. This repository already carried the topic and a valid
manifest, so appearing needed no further step — the install command is the one
in [Install](#from-the-marketplace).

A listing is discovery, not endorsement — the marketplace says the same about
itself, and the [trust guidance](https://herdr.dev/docs/plugins/#trust-and-security)
applies before installing anything.
## Origin

Written against the herdr plugin API as documented at
[herdr.dev/docs/plugins](https://herdr.dev/docs/plugins/) and against the socket
schema dumped locally with `herdr api schema --json`. Every claim in this README
was tested on a live herdr 0.9.0 session; `docs/FINDINGS.md` records the command
and the output behind each one, including the ones that turned out to be false
starts.

## License

[MIT](LICENSE)
