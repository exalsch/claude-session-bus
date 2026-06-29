#!/usr/bin/env node
// Dependency-free smoke test for the mailbox primitives. Exercises append, read,
// origin-filtering, and the cursor flow against a throwaway project dir. Does NOT
// test plugin loading or the live MCP/hook wiring - that needs two real Claude
// sessions (see README "End-to-end test").
//
//   node scripts/selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  appendMessage,
  readMessages,
  mailboxPath,
  ensureDirs,
  originId,
  maxSeq,
  readCursor,
  writeCursor,
} from '../lib/bus.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-bus-'));
process.env.CLAUDE_PROJECT_DIR = tmp;
ensureDirs();

try {
  // Two messages from THIS session (origin = our ppid).
  const a = appendMessage({ text: 'hello', kind: 'note' });
  const b = appendMessage({ text: 'holding :1420', kind: 'lock' });
  assert.equal(readMessages().length, 2, 'two messages persisted');
  assert.equal(b.seq, a.seq + 1, 'seq increments monotonically');

  // Simulate a peer session by writing a line with a different origin.
  const other = {
    seq: b.seq + 1,
    ts: Date.now(),
    origin: `OTHER-${originId()}`,
    from: 'feat/peer',
    kind: 'handoff',
    text: 'pushed branch X',
  };
  fs.appendFileSync(mailboxPath(), JSON.stringify(other) + '\n');

  const msgs = readMessages();
  assert.equal(msgs.length, 3, 'peer message persisted');

  const own = originId();
  const fromOthers = msgs.filter((m) => String(m.origin) !== own);
  assert.equal(fromOthers.length, 1, 'origin filter keeps only the peer message');
  assert.equal(fromOthers[0].text, 'pushed branch X', 'correct peer message survives the filter');

  // Cursor flow: forward-only first sight parks the cursor at the tail.
  writeCursor('sess1', { seq: maxSeq(msgs), ts: Date.now() });
  assert.equal(readCursor('sess1').seq, maxSeq(msgs), 'cursor round-trips');

  console.log('selftest OK -', { seqs: msgs.map((m) => m.seq), tmp });
  process.exitCode = 0;
} catch (e) {
  console.error('selftest FAILED:', e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
