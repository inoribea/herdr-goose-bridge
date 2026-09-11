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
| What works instead? | A pane title of `🪿 goose` **and** goose's UI markers on the screen (two factors). |
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

## 8. Still unverified

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
