# goose-bridge 实测结论（2026-09-11，herdr 0.9.0 / Windows / goose 1.50）

全部结论都在这台机器上跑出来过，不是读文档推的。命令与输出要点附在每条后面。

## 结论速览

| 问题 | 结论 |
| --- | --- |
| 外部进程能代别的 pane 上报吗 | 能，`pane_id` 是普通过位置参数 |
| 上报的状态会显示吗 | 会，`herdr pane list` 立刻出现 `agent` / `agent_status` |
| `--seq` 语义 | 每 (pane, source, agent) 一条持久高水位线；≤ 它的上报被静默丢弃 |
| release 会重置高水位线吗 | 不会 |
| release 会清掉界面上的 agent 名吗 | 不会，最后已知值一直挂着；CLI 里**没有** clear-agent-authority |
| 靠前台进程名能认出 goose 吗 | **不能**（Windows 上 goose 是行模式 CLI，前台仍是 powershell.exe） |
| 那靠什么认 | pane 标题变成 `🪿 goose` + 屏幕里有 goose 的界面标记（双因子） |
| `[[startup]]` 能放常驻 watcher 吗 | **不能**，文档明确说 startup 是一次性钩子，不是守护进程的地方 |
| 常驻进程放哪 | `[[panes]]` 插件 pane（本次：tab 里的 w1:p6） |
| 插件日志 | `herdr plugin log list` 全程为空，连插件 pane 都没有记录 |

## 1. 跨 pane 上报成立

```
herdr pane report-agent w1:p1 --source custom:goose --agent goose --state working --seq 100
herdr pane list   → {"agent":"goose","agent_status":"working", ...}
```
schema 佐证：`PaneReportAgentParams.required = [pane_id, source, agent, state]`，
`PaneAgentState.enum = [idle, working, blocked, unknown]`。

## 2. `--seq` 是持久高水位线，release 不重置

```
report working --seq 100   → working
release-agent
report idle    --seq 50    → 被忽略，仍是 working
```
所以：进程重启后如果 seq 从 1 重数，**上报会被永久丢弃**。
修法：`seq = max(seq+1, Date.now()*1000)`（毫秒时间戳构造上单调，1.7e15 < 2^53）。

## 3. release 不清显示值，也没有 CLI 能清

- release 前后 `revision` 都是 3，`agent` / `agent_status` 都还在 → 交回的是**生命周期权威**，不是显示值。
- `herdr pane report-metadata --clear-display-agent --clear-state-labels` 跑了，没报错也没效果（那是 metadata 层，另一回事）。
- `clear-agent-authority` **只在 socket API 里**，`herdr pane` 和 `herdr api` 都没有这个子命令（`herdr api` 只有 snapshot / schema）。
- 所以：pane 上如果留了 `agent: "goose"`，只能等 herdr 重启或该 pane 真的再跑一次 agent 流程。我测试期间在 w1:p1 上留了这样的残留，release 无效，已如实说明。

## 4. 检测：踩过两次假阳性，最后是靠标题

第一次错在拿整个 `process-info` JSON 的所有字符串比 basename：
```
foreground: powershell.exe
cwd: C:\Users\inori\goose\        ← basenameLike() → "goose" → 命中 ^goose$
```
第二次错在 pane 记录的 `agent` 字段（它回显上次上报的 agent 名，会永远自我匹配）。

**真 goose 实测**（split 一个临时 pane，里面跑真 goose）：
```
foreground=["powershell.exe", ...]        ← goose 跑起来了，前台进程还是 powershell
terminal_title="🪿 goose"                 ← 但标题变了
屏幕:   __( O)>  ● new session · custom_deepseek deepseek-v4-flash
        goose is ready / ⏳ loading extensions / > Enter to send · Ctrl+J newline
```
结论：**Windows 上 goose 的进程名进不了 foreground_processes**（行模式 CLI，不是全屏 TUI 接管控制台），
只能靠「标题命中 + 屏幕标记命中」双因子认它。已按此重写检测逻辑，实测：
```
w1:p3 goose=true title="🪿 goose" screen=true     （真 goose 在跑）
w1:p1 goose=false title="管理员: ...powershell.exe" screen=false（同目录，不误报）
w1:p6 goose=false title="" screen=false           （watcher 自己的 pane，node.exe）
```
屏幕双因子的副作用正好是好事：goose 退出后标题可能还留着，但屏幕恢复 shell 提示符 → 判定为非法 → 自动 release。

## 5. `[[startup]]` 的语义（官方文档原文）

> `[[startup]]` commands run once for each enabled plugin after Herdr restores the session and its API socket is ready. They run again when a new server takes over during live handoff, but not when a client attaches, config reloads, or **a plugin is linked or enabled**.
> A startup hook is not a place for long-running daemons … A hook should restore plugin-owned state, call any required Herdr APIs, and exit.

两个后果：
1. 插件刚 link 完 startup **不会**跑（本机 herdr server 10:01 启动，插件是之后链的，所以一直没跑）→ 需要一次 herdr 重启才会自动跑。
2. 常驻的东西不该塞在 startup 里 → 改成：startup 钩子 `bin/autostart.js` 只做一件事——让 herdr 打开插件 pane，然后退出。

## 6. 插件 pane 才是长驻进程的正确位置

```
[[panes]]
id = "watcher"
title = "goose bridge"
placement = "tab"
command = ["node", "bin/bridge.js"]

herdr plugin pane open --plugin goose.bridge --entrypoint watcher --placement tab --no-focus
```
实测：开出一个 tab（w1:p6，label "goose bridge"），watcher 在里面常驻，日志直接打在 pane 屏幕上
（`herdr plugin log list` 一直是空的，所以排查只能看屏幕）。

`autostart.js` 幂等双重保险，实测第二次调用输出
`watcher already running (pid 37092); nothing to do`，没有开第二个 pane：
- pid 文件：`%LOCALAPPDATA%\herdr\plugins\goose.bridge\goose-bridge-watcher.pid`（=HERDR_PLUGIN_STATE_DIR），顺便做存活检查
- 标签检查：`herdr pane list` 里已经有 label 为 "goose bridge" 的 pane

watcher 自己会跳过自己（`HERDR_PANE_ID` 对比，实测 `own pane w1:p6`）。

## 7. 杂项观察

- 上报 `idle` 时，`pane list` 里显示的可能是 `done`（两次实测分别见到 `idle` 和 `done`）。显示值的映射规则没查清，标[猜测]：与是否有客户端 attached 有关。对桥本身无影响。
- pane 关闭后再 release 会返回 `pane_not_found` 错误 → 已按「不是错误」处理并打日志。
- `pane.close` 时子进程退出码 3221225786（0xC000013A = STATUS_CONTROL_C_EXIT），正常。

## 8. 仍未验证

- live handoff / 重启后 startup 是否真的把 watcher tab 开起来（要重启 herdr 才能验证，会动用户的会话，没擅自做）。
- goose 交互式对话时 TUI 会重绘（token 流、耗时行）→ 输出哈希会一直变 → 可能永远停在 `working`。目前只验证到「静止时报 idle」。若真出现，需要给哈希做 UI 壳层归一化。
- `blocked` 仍是正则猜的（`allow?` / `approve` / `permission` / `press enter` …），没在真 goose 权限提示上验证过。
- goose 有没有原生生命周期钩子能替代这套启发式状态机，未知。
