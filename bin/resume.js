'use strict';
/**
 * Pure helpers for the resume command goose-bridge attaches to state reports.
 *
 * herdr (0.9.2+) can reopen an agent's session after a server restart when the
 * agent reports the command that resumes it (`pane report-agent ... -- <argv>`).
 * This module decides whether a goose session is safe to report and builds the
 * argv. It has no I/O, so it is unit-tested without herdr or goose.
 *
 * Rules, from herdr's add-herdr-support guide:
 *   - the first word is a plain command name on PATH, not a path;
 *   - no argument contains an apostrophe or a control character;
 *   - at most 64 arguments and 8 KiB in total.
 *
 * goose's session ids look like 20261124_5 (docs: session-management).
 */

const SESSION_ID = /^\d{8}_\d+$/;

const MAX_ARGS = 64;
const MAX_BYTES = 8 * 1024;

function resumeArgvOk(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > MAX_ARGS) return false;
  if (/[\\/]/.test(argv[0])) return false;
  let bytes = 0;
  for (const a of argv) {
    if (typeof a !== 'string') return false;
    if (/['\u0000-\u001f\u007f]/.test(a)) return false;
    bytes += Buffer.byteLength(a, 'utf8');
  }
  return bytes <= MAX_BYTES;
}

/** The argv that resumes one goose session, or null when the id is unusable. */
function resumeArgvFor(gooseBin, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
  const argv = [gooseBin, 'session', '-r', '--session-id', sessionId];
  return resumeArgvOk(argv) ? argv : null;
}

const normDir = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();

/**
 * Pick the session to resume from `goose session list --format json` output.
 * Only a session with a valid id whose working_dir equals the pane's cwd
 * counts; the most recently updated one wins. Returns the id or null.
 */
function pickSession(json, cwd) {
  let rows;
  try {
    rows = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !cwd) return null;
  const want = normDir(cwd);
  const hits = rows
    .filter(
      (r) =>
        r &&
        typeof r.id === 'string' &&
        SESSION_ID.test(r.id) &&
        typeof r.working_dir === 'string' &&
        normDir(r.working_dir) === want,
    )
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return hits.length ? hits[0].id : null;
}

module.exports = { SESSION_ID, resumeArgvOk, resumeArgvFor, pickSession };
