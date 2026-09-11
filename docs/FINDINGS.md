# goose-bridge findings (2026-09-11, herdr 0.9.0 / Windows / goose 1.50)

Every claim below was produced on this machine. None of it is inferred from
documentation; the command and the relevant output are attached to each claim.

## Summary

| Question | Answer |
| --- | --- |
| Can an external process report state for another pane? | Yes. `pane_id` is an ordinary positional argument. |
| Does the reported state show up? | Yes. `herdr pane list` gains `agent` / `agent_status` immediately. |
| `--seq` semantics | A persistent high-water mark per (pane, source, agent); any report at or below it is silently dropped. |
| Does `release-agent` reset the high-water mark? | No. |
| Does release clear the displayed agent name? | No. The last known value stays on the pane and no CLI command clears it (`clear-agent-authority` is socket-only). |
| Can goose be recognised by its foreground process name? | **No.** On Windows goose is a line-mode CLI; the foreground process stays `powershell.exe`. |
| What works instead? | A pane title carrying goose's own emoji (`🪿 <directory>`) **and** goose's UI markers on the screen (two factors) — the pattern was the bare word `goose` until §13 corrected it. |
| Can `[[startup]]` host the long-lived watcher? | **No.** The docs say a startup hook is one-shot and not a place for daemons. |
| Where does the long-lived process live? | In a `[[panes]]` plugin pane (here: w1:p6, in its own tab). |
| Plugin logs | `herdr plugin log list` stayed empty for the whole session, down to the plugin's own pane. |

## 1. Cross-pane reporting works

```
herdr pane report-agent w1:p1 --source custom:goose --agent goose --state working --seq 100
herdr pane list   → {"agent":"goose","agent_status":"working", ...}
```

The schema agrees: `PaneReportAgentParams.required = [pane_id, source, agent,
state]` and `PaneAgentState.enum = [idle, working, blocked, unknown]`.

## 2. `--seq` is a persistent high-water mark, and release does not reset it

```
report working --seq 100   → working
release-agent
report idle    --seq 50    → ignored, the pane stays working
```

So a process that restarts its counter at 1 has its reports **dropped forever**.
The fix is `seq = max(seq + 1, Date.now() * 1000)`: a millisecond timestamp is
monotonic by construction, and 1.7e15 is far below 2^53.

## 3. Release does not clear the displayed value, and nothing in the CLI can

- `revision` was 3 before and after the release, with `agent` / `agent_status`
  still on the pane. What is handed back is the **lifecycle authority**, not the
  displayed value.
- `herdr pane report-metadata --clear-display-agent --clear-state-labels` ran
  without an error and had no visible effect. That is the metadata layer, a
  different thing.
- `clear-agent-authority` exists **only in the socket API**. Neither
  `herdr pane` nor `herdr api` has that subcommand (`herdr api` only has
  `snapshot` and `schema`).
- Consequence: once `agent: "goose"` is stuck on a pane, only a herdr restart or
  the pane really running an agent again will clear it. My tests left exactly
  such a residue on w1:p1, release does not remove it, and this file says so.
- Follow-up at 18:27: the residue is gone, because the workspace that carried it
  (w1) had been closed and the new workspace (w2) started clean. That is not
  evidence that a restart cleans a *restored* pane: the pane that carried the
  residue did not come back. The value the bridge shows on w2:p1 is its own, at
  `revision` 2. Restore-behaviour for a sticky value remains untested.

## 4. Detection: two false positives, then the title-and-screen rule

The first mistake was comparing every string of the whole `process-info` JSON
against the basename pattern:

```
foreground: powershell.exe
cwd: C:\Users\inori\goose\        ← basenameLike() → "goose" → matched ^goose$
```

The second mistake was reading the pane record's `agent` field, which echoes the
last reported agent name and therefore matches the pane against itself forever.

**A real goose session** (a throwaway split pane running goose):

```
foreground=["powershell.exe", ...]        ← goose is running; the foreground process is still powershell
terminal_title="🪿 goose"                 ← but the title changed
screen: __( O)>  ● new session · custom_deepseek deepseek-v4-flash
        goose is ready / ⏳ loading extensions / > Enter to send · Ctrl+J newline
```

Conclusion: **on Windows, goose's process name never reaches
`foreground_processes`** (it is a line-mode CLI, not a full-screen TUI that takes
over the console), so the only way to recognise it is a title match **plus** a
screen-marker match. The detection logic was rewritten on that basis and
measured:

```
w1:p3 goose=true  title="🪿 goose" screen=true                    (a real goose session)
w1:p1 goose=false title="Administrator: ...powershell.exe" screen=false  (same cwd, no false positive)
w1:p6 goose=false title="" screen=false                            (the watcher's own pane, node.exe)
```

The second factor has a useful side effect: when goose exits its title can
linger, but the screen goes back to a shell prompt, which is not a goose screen,
so the pane gets released instead of misreported.

## 5. What `[[startup]]` actually means (quoted from the official docs)

> `[[startup]]` commands run once for each enabled plugin after Herdr restores
> the session and its API socket is ready. They run again when a new server takes
> over during live handoff, but not when a client attaches, config reloads, or
> **a plugin is linked or enabled**.
> A startup hook is not a place for long-running daemons … A hook should restore
> plugin-owned state, call any required Herdr APIs, and exit.

Two consequences:

1. A freshly linked plugin does **not** run its startup hook. (Here the herdr
   server started at 10:01 and the plugin was linked later, so it never ran at
   all until a herdr restart.)
2. A long-lived process does not belong in a startup hook. The hook
   `bin/autostart.js` now does exactly one thing: ask herdr to open the plugin's
   watcher pane, then exit.

**Verified at 18:27**, on a real server restart (`server shutdown initiated`,
then `herdr server started … pid=36020` at 10:27:45.429Z):

```
10:27:45.429675  herdr server started api_socket=...\herdr.sock
10:27:45.438279  client connected client_id=2 ... surface_active=true
10:27:45.556982  api request received method="plugin.pane.open" request_id="cli:plugin"
10:27:45.591949  pane child spawned pane_id=2 pid=21280
```

127 ms after the API socket came up, and 118 ms after the terminal client
connected, a `cli:plugin` request opened the watcher pane (w2:p2, pid 21280,
label `goose bridge`). No human types that fast, so this was the startup hook:
the question left open in the previous session is answered **yes**. The restored
goose pane (w2:p1, `terminal_title` `🪿 goose`) was picked up by the new watcher
on its own, and `pane list` shows `agent: "goose"` at `revision` 2 — matching the
two reports the watcher logged (`(none) -> working`, then `working -> idle`).

## 6. A plugin pane is the right home for the long-lived process

```
[[panes]]
id = "watcher"
title = "goose bridge"
placement = "tab"
command = ["node", "bin/bridge.js"]

herdr plugin pane open --plugin goose.bridge --entrypoint watcher --placement tab --no-focus
```

Measured: this opens a tab (w1:p6, label `goose bridge`), the watcher lives in it,
and its log goes straight to the pane screen — `herdr plugin log list` was empty
the whole time, so the pane screen is the only place to debug.

`autostart.js` is idempotent two ways over. A second call printed
`watcher already running (pid 37092); nothing to do` and did not open a second
pane:

- a pid file at `%LOCALAPPDATA%\herdr\plugins\goose.bridge\goose-bridge-watcher.pid`
  (= `HERDR_PLUGIN_STATE_DIR`), also used as a liveness check, and
- a label check: a pane labelled `goose bridge` already exists in `herdr pane list`.

The watcher also skips its own pane by comparing against `HERDR_PANE_ID`
(observed: `own pane w1:p6`).

## 7. Smaller observations

- A reported `idle` can display as `done` in `pane list` (seen in both forms
  across runs, `done` on w2:p1 at 18:29). The mapping is not understood; [guess]
  it depends on whether a client is attached. It does not affect the bridge.
- The watcher skips itself in a new workspace without being told (observed:
  `own pane w2:p2`), and `w2:p2` carries no `agent` field in `pane list` — the
  self-report guard holds across a restart.
- Releasing a pane that has already been closed returns a `pane_not_found` error.
  That is treated as "nothing to release", not as a failure, and logged as such.
- The child of `pane.close` exits with code 3221225786 (0xC000013A =
  STATUS_CONTROL_C_EXIT). Normal for a Ctrl-C'd child.

## 8. A freshly seen pane is never reported as `working`

The first version started the quiet timer the moment a pane was first tracked,
so `quietFor` was ~0 and every pane it had just discovered was reported
`working`, then `idle` one quiet window later. The restart log shows it on a
goose pane that was sitting idle at its prompt:

```
[goose-bridge] w2:p1: (none) -> working
[goose-bridge] w2:p1: working -> idle
```

Fixed at 18:33: the first observation is stored as a baseline and does not count
as a change (`primed` / `changes` in `classify()`), and while nothing has changed
inside the quiet window `classify()` returns nothing rather than guessing.
Verified against a real scratch pane, with a separate `--source` so the running
watcher was untouched (`POLL_MS=1000`, `IDLE_AFTER_MS=4000`):

```
[goose-bridge] w2:p3: first sight, waiting for the screen to settle before guessing
[goose-bridge] w2:p3: (none) -> idle        ← an idle pane no longer flashes working
    ... activity injected into the pane with `pane send-text` ...
[goose-bridge] w2:p3: idle -> working
[goose-bridge] w2:p3: working -> idle
```

A pane that is genuinely working still reports `working` within one poll: the
report is deferred by a poll, never suppressed. The scratch pane was closed
after the run.

## 9. Still unverified

- Live handoff (a new server taking over while a client stays attached) is still
  untested. The docs say the startup hook runs there too; only a full restart has
  been observed (see §5).
- Whether goose's interactive turn keeps redrawing the TUI (token stream, elapsed
  line) and therefore keeps the output hash changing, so the pane sticks at
  `working` forever. Only the quiet case (`idle`) was verified. If it happens, the
  hash needs to normalise the UI chrome away.
- `blocked` is still a regex guess (`allow?` / `approve` / `permission` /
  `press enter` …) and has never been checked against a real goose permission
  prompt.
- Whether goose has a native lifecycle hook that could replace this heuristic
  state machine at all.

## 10. Marketplace listing and the GitHub install

Observed 2026-09-11 on herdr 0.9.0 (Windows), Node 24.

**Listing.** The repository is on [herdr.dev/plugins](https://herdr.dev/plugins/),
under "New to the herd":

```
inoribea/herdr-goose-bridge
Herdr plugin that reports goose agent lifecycle state (idle / working / blocked)
into your panes. goose is a line-mode CLI, so Herdr cannot detect it on its own.
✦ joined 27m ago ★0
```

That matches the published index rules: public repository, GitHub topic
`herdr-plugin`, at least one `herdr-plugin.toml` with parseable required metadata
on the default branch, one card per repository, refresh every 30 minutes, rescan
when the default-branch head changes, forks and archived repositories excluded
([herdr.dev/docs/marketplace](https://herdr.dev/docs/marketplace/)).

**Install.** `herdr plugin install inoribea/herdr-goose-bridge --yes` was replayed
end to end with the plugin data directory pointed at a throwaway directory, so
this machine's own linked plugin was left alone (checked afterwards: `herdr plugin
list` still showed all four plugins, with goose.bridge linked from the local
checkout). No herdr server was running:

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
Installed goose.bridge from inoribea/herdr-goose-bridge.
```

`herdr plugin list` then reported
`- goose.bridge (goose state bridge) enabled [github:inoribea/herdr-goose-bridge@6390d8409e8a93c9bfdf61fccc68165c361ab8c9]`
— the resolved commit, not the requested ref — and the checkout landed in
`<data dir>/plugins/github/goose.bridge-f5f980f35af9`. Install registered the
plugin enabled with no server running.

**A local link beats a GitHub install.** Replaying the install while the same
plugin id was linked from a checkout is refused, with the reason in the message:

```
Error: Custom { kind: Other, error: "plugin goose.bridge is already linked from a local path; uninstall/unlink it before installing from GitHub" }
```

**Unlink needs a server; link does not.** `herdr plugin link <checkout>` registered
with no server running; `herdr plugin unlink goose.bridge` did not:

```
{"id":"cli:plugin","error":{"code":"server_not_running","message":"no herdr server is running at <data dir>/herdr.sock; run `herdr` to start or attach it"}}
```

So leaving a linked checkout for the marketplace install needs a running Herdr for
the first step. Still unverified here: `--ref` pinning, the interactive
confirmation prompt (`--yes` was passed, and the preview printed anyway),
`min_herdr_version` rejection against an older binary, and `plugin action invoke`
or `plugin log`, which need a server this session did not have.

## 11. A restored plugin pane is a shell wearing the watcher's title

Herdr restores the panes of the previous session *before* it runs the
`[[startup]]` hooks. For a plugin pane that restore does not re-run the pane
command: the pane comes back as the default shell in the recorded cwd, while
`session.json` still records the `launch_argv` that created it. The pane title
survives with it, and the pane title was the only thing the old guard trusted.

| Question | Answer |
| --- | --- |
| Does a restored plugin pane run its pane command? | **No.** It is a shell (`pwsh.exe`) sitting in the plugin directory. |
| What did the old guard do with it? | Logged `watcher pane already open; nothing to do`, exited 0, and the bridge never started — every pane stayed `agent_status: unknown` for the whole session. |
| How are the two told apart? | `pane process-info`: a live watcher pane runs `node.exe`; the leftover runs `pwsh.exe`. |
| Is the hook's stdout recoverable? | Yes — `herdr plugin log list` kept it. The install notes above say it stays empty; that is wrong once a hook has run. |

Observed 2026-09-12, herdr 0.9.0, Windows, plugin 0.2.1, right after a Herdr
restart that restored one shell pane and one plugin pane:

```
$ herdr pane list
… {"label":"goose bridge","pane_id":"w3:p2",
   "cwd":"C:\\Users\\kumax\\AppData\\Roaming\\herdr\\plugins\\github\\goose.bridge-f5f980f35af9",…}
        ← the title is back, two seconds after startup

$ herdr plugin log list
{"command":["node","bin/autostart.js"],"event":"startup","exit_code":0,
 "log_id":"plugin-log-1","plugin_id":"goose.bridge","status":"succeeded",
 "stdout":"[goose-bridge:autostart] watcher pane already open; nothing to do\n"}

$ Get-Process | Where-Object ProcessName -match 'node|goose|herdr'
16924 goose
17088 herdr                 ← and no node at all: the watcher was never running

$ herdr pane process-info --pane w3:p2
… {"foreground_processes":[{"name":"pwsh.exe","argv0":"C:\\Program Files\\PowerShell\\7\\pwsh.EXE",…}]}

$ <data dir>/session.json
      "cwd": "C:\\Users\\kumax\\AppData\\Roaming\\herdr\\plugins\\github\\goose.bridge-f5f980f35af9",
      "label": "goose bridge",
      "launch_argv": ["node","bin/bridge.js"]      ← recorded, never run
```

**Fix.** The guard asks `pane process-info` before it believes a title. A pane
wearing the title, inside the plugin root, with no `node` among its foreground
processes is a leftover: it is closed, then a fresh watcher pane is opened.
`process-info` is read as three-state (`true` / `false` / no answer), so an
unreadable API never gets a live pane closed, and a pane wearing the title from
some other cwd is left alone. Replayed after the fix:

```
$ node bin/autostart.js          # the leftover from the restart was still open
[goose-bridge:autostart] closed leftover pane w3:p2 (wears the pane title, runs no watcher)
[goose-bridge:autostart] watcher pane open requested (tab, no focus)

$ herdr pane process-info --pane w3:p3
… {"foreground_processes":[{"name":"node.exe","argv0":"C:\\Program Files\\nodejs\\node.EXE","pid":1928}]}

$ herdr pane read w3:p3 --source recent --lines 12
[goose-bridge] watching (poll 2000ms, source custom:goose, agent goose)
[goose-bridge] state dir C:\Users\kumax\AppData\Local\herdr\plugins\goose.bridge
[goose-bridge] own pane w3:p3

$ node bin/autostart.js          # a real watcher pane: the guard leaves it alone
[goose-bridge:autostart] watcher already running in w3:p3; nothing to do
```

The second run is the input the hook sees whenever the pane really is the
watcher, so the guard is idempotent in both directions: it closes what only
looks like a watcher and spares what is one.

## 12. Detection: what this session could not settle

Same machine, same session, with the watcher fixed. No goose was running inside
a herdr pane, so end-to-end detection could not be replayed:

- **A goose session outside Herdr is invisible.** `goose.exe session -r` was
  running under `pwsh.exe → wezterm-gui.exe → explorer.exe` — a WezTerm window —
  while both herdr panes ran `pwsh.exe`. The bridge only reads herdr panes
  (`pane list`), so there was nothing to report. Correct behaviour, worth knowing
  before blaming the bridge.
- **The title factor was not re-checked.** The pane that had hosted a goose
  session reported `terminal_title` `kumax: C:\Users\kumax\code` — herdr's own
  `user: cwd` default — but that session had already printed
  `● session closed · 20260911_7`. That says nothing about a live session, so
  §4 stands until it is replayed against a live goose-in-a-herdr-pane.
- **Screen markers outlive the session.** `--dry-run` on that same pane reported
  `screen=true`, from the banner of a session that had already closed. So
  `GOOSE_BRIDGE_SCREEN=1` alone would call a dead pane a goose; the
  title-plus-screen rule in §4 is what keeps that honest.

```
$ node bin/bridge.js --dry-run
[goose-bridge]   w3:p1 goose=false title="kumax: C:\\Users\\kumax\\code" screen=true
```

## 13. goose's pane title is the goose emoji plus the directory name

§4 established that on Windows the recognisable half of goose is its pane title
**plus** its screen markers, and set `GOOSE_BRIDGE_TITLE` to the bare word
`goose`. Replayed on 2026-09-12 with two live sessions in two different
directories: the title is goose's own emoji followed by the basename of the
session's cwd. The original `🪿 goose` in §4 was a session that happened to run
in a directory called `goose`; in any other directory the title carries no word
the default pattern could match, so the rule never fired:

```
$ herdr pane list                     # two live goose sessions, two cwds
w3:p4  unknown  🪿 code               # cwd C:\Users\kumax\code
w3:p5  unknown  🪿 goose              # cwd %TEMP%\goose

$ node bin/bridge.js --dry-run        # plugin 0.2.2, default title pattern "goose"
[goose-bridge]   w3:p1 goose=false title="kumax: C:\\Users\\kumax\\code" screen=true
[goose-bridge]   w3:p5 goose=true  title="🪿 goose" screen=true
[goose-bridge]   w3:p4 goose=false title="🪿 code"  screen=true
        ← only the session living in a directory named goose was recognised, and
          herdr showed both panes as agent:"" agent_status:"unknown"
```

Both panes were started for this replay with
`herdr pane split --cwd <dir>` followed by
`herdr pane run <pane> goose.exe session`, and closed again afterwards. The
`goose.exe session -r` in WezTerm is the author's own session, which this bridge
never sees (§12).

**Fix.** The default title pattern matches goose's own emoji (`\u{1FABF}`) as
well as the word, so the invariant part of the title is what is checked and the
directory name stops deciding. The title factor keeps working as the second half
of the two-factor rule: when goose exits, the shell prompt repaints the title
without the emoji — `kumax: C:\Users\kumax\code` above — so the pane is released
instead of lying. Replayed after the fix, watcher pane restarted to load it:

```
$ node bin/bridge.js --dry-run
[goose-bridge]   w3:p5 goose=true  title="🪿 goose" screen=true
[goose-bridge]   w3:p4 goose=true  title="🪿 code"  screen=true
[goose-bridge]   w3:p1 goose=false title="kumax: C:\\Users\\kumax\\code" screen=true
        ← the pane whose goose session had already closed stays unrecognised

$ herdr pane read <watcher pane> --source recent --lines 20
[goose-bridge] w3:p5: first sight, waiting for the screen to settle before guessing
[goose-bridge] w3:p4: first sight, waiting for the screen to settle before guessing
[goose-bridge] w3:p5: (none) -> idle
[goose-bridge] w3:p4: (none) -> idle

$ herdr pane get w3:p4
{"agent":"goose","agent_status":"idle","cwd":"C:\\Users\\kumax\\code",
 "terminal_title":"🪿 code","revision":3,…}

$ herdr pane close w3:p4 ; herdr pane close w3:p5
[goose-bridge] w3:p5: gone (nothing to release)
[goose-bridge] w3:p4: gone (nothing to release)
```

This is the first replay in this file where a goose pane actually carried
`agent: "goose"` through the bridge rather than through a hand-run
`report-agent`.

**Still open.** Whether goose's title survives when a session exits without the
shell repainting its prompt (a killed pane, a shell that prints nothing after
goose returns). That is the false-positive case for the two-factor rule and it
has not been observed either way.
