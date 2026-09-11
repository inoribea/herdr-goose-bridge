# AGENTS.md

Before finishing any change, run:

```bash
npm run check                  # node --check on every script + scripts/verify.mjs
node bin/bridge.js --dry-run   # on a machine that runs herdr: print what it sees
```

`npm run check` needs no herdr, no network and no `npm install`. It fails the
build on the invariants below, so a violation is caught before review.

Repository rules:

- Use Conventional Commits for commit messages and PR titles.
- `[[startup]]` hooks are one-shot. They restore plugin-owned state, call the
  herdr API, and exit. Long-lived work belongs in a `[[panes]]` entrypoint.
- Never change the default `GOOSE_BRIDGE_SOURCE` / `GOOSE_BRIDGE_AGENT` pair
  silently. The pair keys herdr's persistent per-(pane, source, agent) sequence
  watermark; changing it orphans every pane already reported under the old pair.
- `--seq` must be monotonic across process restarts (`Date.now() * 1000`), not a
  counter starting at 1. Herdr silently drops any report at or below the stored
  high-water mark, and `release-agent` does not reset it.
- Detection must not read the pane-record `agent`, `agent_status`, `title` or
  `label` fields. Herdr echoes the last reported agent back into `agent`, so
  matching it makes a pane match itself forever.
- This bridge is read-only plus state reports. It never sends input to a pane
  (`pane send-text` / `pane send-keys` are off limits) and never writes outside
  `HERDR_PLUGIN_STATE_DIR`.
- Every empirical claim in the README needs a command and its observed output in
  `docs/FINDINGS.md`. A behaviour that has not been observed on a live session
  is documented as unverified, not as fact.
- Keep the plugin usable by hand: the same scripts the manifest calls must run
  standalone (`--dry-run`, `release-all`) so behaviour can be checked without
  reloading anything.
