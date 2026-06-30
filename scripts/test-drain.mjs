#!/usr/bin/env node
// Integration test for the receive half (scripts/drain.mjs).
//
// Models two sessions sharing one project mailbox and asserts the origin self-filter
// end to end (stdin -> additionalContext stdout): a session must SEE a peer's
// broadcast but NOT its own. With the fix, "own" is keyed off CLAUDE_CODE_SESSION_ID,
// so this holds regardless of process.ppid / spawn path.
//
//   node scripts/test-drain.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const drain = path.join(here, 'drain.mjs');

const SID_A = 'sid-AAAA';
const SID_B = 'sid-BBBB';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bus-drain-'));
const busDir = path.join(tmp, '.claude', '.session-bus');
fs.mkdirSync(path.join(busDir, 'cursors'), { recursive: true });

// One broadcast from session A, stamped origin = A's session id (as the fixed sender does).
const msg = { seq: 1, ts: Date.now(), origin: SID_A, from: 'feat/a', kind: 'note', text: 'editing dynamics.rs' };
fs.writeFileSync(path.join(busDir, 'mailbox.jsonl'), JSON.stringify(msg) + '\n');
fs.writeFileSync(path.join(busDir, 'seq'), '1');

function runHook(sessionId) {
  // Pre-park the cursor at seq 0 so this is not a forward-only "first sight"
  // (first sight parks at the tail and delivers nothing - covered in selftest).
  fs.writeFileSync(path.join(busDir, 'cursors', `${sessionId}.json`), JSON.stringify({ seq: 0, ts: 0 }));
  const res = spawnSync('node', [drain], {
    input: JSON.stringify({ session_id: sessionId, cwd: tmp }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmp, CLAUDE_CODE_SESSION_ID: sessionId },
  });
  return res.stdout || '';
}

try {
  // Session B (a peer) MUST see A's broadcast.
  const bOut = runHook(SID_B);
  assert.ok(bOut.includes('editing dynamics.rs'), "peer session B receives A's broadcast");
  // ...and the label carries the #<session> suffix so same-branch sessions are distinct.
  assert.ok(bOut.includes('feat/a#sid-AAAA'), 'rendered label carries the #<session> suffix');

  // Session A MUST NOT see its own broadcast (origin self-filter).
  const aOut = runHook(SID_A);
  assert.ok(!aOut.includes('editing dynamics.rs'), 'session A does NOT receive its own broadcast');

  console.log('drain integration test OK');
  process.exitCode = 0;
} catch (e) {
  console.error('drain integration test FAILED:', e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
