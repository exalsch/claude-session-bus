#!/usr/bin/env node
// Regression test for originId() session correlation.
//
// The send half (MCP server) is a DIRECT child of claude.exe; the receive half
// (UserPromptSubmit hook) is shell-wrapped, so on Windows their process.ppid values
// differ and a ppid-based origin can never match across the two halves. originId()
// must instead key off CLAUDE_CODE_SESSION_ID, which claude.exe sets in the
// environment every child inherits.
//
//   node scripts/test-origin.mjs

import assert from 'node:assert/strict';
import { originId } from '../lib/bus.mjs';

try {
  // 1. When CLAUDE_CODE_SESSION_ID is present, originId() uses it (NOT ppid).
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-ABC-123';
  assert.equal(
    originId(),
    'sess-ABC-123',
    'originId() returns CLAUDE_CODE_SESSION_ID when set',
  );
  assert.notEqual(
    originId(),
    String(process.ppid),
    'originId() does not fall back to ppid when the session id is available',
  );

  // 2. Fallback: when the env var is absent, originId() uses process.ppid.
  delete process.env.CLAUDE_CODE_SESSION_ID;
  assert.equal(
    originId(),
    String(process.ppid),
    'originId() falls back to ppid when CLAUDE_CODE_SESSION_ID is unset',
  );

  console.log('origin test OK');
  process.exitCode = 0;
} catch (e) {
  console.error('origin test FAILED:', e.message);
  process.exitCode = 1;
}
