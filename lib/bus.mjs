// Shared mailbox primitives for the session-bus plugin.
//
// One append-only JSONL mailbox per project, keyed off CLAUDE_PROJECT_DIR so the
// same plugin instance only ever bridges sessions that share a project root.
// The MCP server (sender) and the UserPromptSubmit hook (receiver) both import
// this module; it is the single source of truth for paths, identity, locking,
// and message shape.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Retention: a rolling window, not durable history (see spec, "out of scope").
const MAX_LINES = 500;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Advisory file lock (mkdir is atomic on every platform we care about).
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3_000;

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function busDir(proj = projectDir()) {
  return path.join(proj, '.claude', '.session-bus');
}

export function mailboxPath(proj = projectDir()) {
  return path.join(busDir(proj), 'mailbox.jsonl');
}

function counterPath(proj = projectDir()) {
  return path.join(busDir(proj), 'seq');
}

export function cursorPath(sessionId, proj = projectDir()) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(busDir(proj), 'cursors', `${safe}.json`);
}

// Per-session origin: the key that lets the receiver filter out its own broadcasts.
// It must be computed identically by BOTH halves of a session - the MCP server and
// the UserPromptSubmit hook. process.ppid does NOT work for this on Windows: the MCP
// server is a direct child of claude.exe, but the hook is shell-wrapped, so their
// ppids differ and a ppid-based origin never matches across the two halves (the spec
// "Risks" spike confirmed this). CLAUDE_CODE_SESSION_ID is set by claude.exe and
// inherited by every child regardless of spawn path, so both halves agree on it.
// Fall back to ppid only where the env var is absent (older CLIs / other runtimes).
export function originId() {
  return process.env.CLAUDE_CODE_SESSION_ID || String(process.ppid);
}

export function ensureDirs(proj = projectDir()) {
  fs.mkdirSync(path.join(busDir(proj), 'cursors'), { recursive: true });
}

let cachedFrom = null;
export function fromLabel(proj = projectDir()) {
  if (cachedFrom) return cachedFrom;
  let branch = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: proj,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    // not a git repo - fall back to the directory name
  }
  cachedFrom = branch && branch !== 'HEAD' ? branch : path.basename(proj);
  return cachedFrom;
}

function sleep(ms) {
  // Synchronous sleep with no dependencies. Atomics.wait is permitted on Node's
  // main thread; ms here is tiny (lock retry backoff).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockPath(proj) {
  return path.join(busDir(proj), '.lock');
}

function acquireLock(proj) {
  const lp = lockPath(proj);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lp);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lp);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lp);
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat - retry immediately
      }
      if (Date.now() > deadline) throw new Error('session-bus: lock timeout');
      sleep(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(proj) {
  try {
    fs.rmdirSync(lockPath(proj));
  } catch {
    // already released / broken as stale
  }
}

export function withLock(fn, proj = projectDir()) {
  ensureDirs(proj);
  acquireLock(proj);
  try {
    return fn();
  } finally {
    releaseLock(proj);
  }
}

function nextSeq(proj) {
  const cp = counterPath(proj);
  let n = 0;
  try {
    n = parseInt(fs.readFileSync(cp, 'utf8').trim(), 10) || 0;
  } catch {
    // first message
  }
  n += 1;
  fs.writeFileSync(cp, String(n));
  return n;
}

// Called under the lock. Drops aged-out and over-cap lines. The seq counter is a
// separate file, so trimming never reuses sequence numbers.
function trim(proj) {
  const mp = mailboxPath(proj);
  let lines;
  try {
    lines = fs.readFileSync(mp, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  const cutoff = Date.now() - MAX_AGE_MS;
  let kept = lines.filter((l) => {
    try {
      return JSON.parse(l).ts >= cutoff;
    } catch {
      return false;
    }
  });
  if (kept.length > MAX_LINES) kept = kept.slice(kept.length - MAX_LINES);
  if (kept.length !== lines.length) {
    fs.writeFileSync(mp, kept.length ? kept.join('\n') + '\n' : '');
  }
}

export function appendMessage({ text, kind = 'note' }, proj = projectDir()) {
  return withLock(() => {
    const msg = {
      seq: nextSeq(proj),
      ts: Date.now(),
      origin: originId(),
      from: fromLabel(proj),
      kind,
      text,
    };
    fs.appendFileSync(mailboxPath(proj), JSON.stringify(msg) + '\n');
    trim(proj);
    return msg;
  }, proj);
}

export function readMessages(proj = projectDir()) {
  let raw;
  try {
    raw = fs.readFileSync(mailboxPath(proj), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip a partial line from an interleaved append
    }
  }
  return out;
}

export function maxSeq(messages) {
  return messages.reduce((m, x) => Math.max(m, x.seq || 0), 0);
}

export function readCursor(sessionId, proj = projectDir()) {
  try {
    return JSON.parse(fs.readFileSync(cursorPath(sessionId, proj), 'utf8'));
  } catch {
    return null;
  }
}

export function writeCursor(sessionId, cursor, proj = projectDir()) {
  ensureDirs(proj);
  const cp = cursorPath(sessionId, proj);
  const tmp = `${cp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor));
  fs.renameSync(tmp, cp);
}
