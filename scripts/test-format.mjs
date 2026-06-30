#!/usr/bin/env node
// Unit test for formatMessage() - the shared one-line peer-notice renderer.
//
// The from-label is suffixed with a short slice of the message origin (the session
// id) so that sessions sharing a branch name stay distinguishable in the feed.
//
//   node scripts/test-format.mjs

import assert from 'node:assert/strict';
import { formatMessage } from '../lib/bus.mjs';

try {
  // Appends #<first 8 of origin> to the branch label.
  assert.equal(
    formatMessage({ ts: 0, origin: '16da9437-57ae-1111', from: 'master', kind: 'note', text: 'hi' }),
    '- 00:00 master#16da9437: hi',
    'tags the from-label with the short session id',
  );

  // Keeps the [kind] tag, placed after the session suffix.
  assert.equal(
    formatMessage({ ts: 0, origin: 'bbbbbbbb-2222', from: 'feat/x', kind: 'lock', text: 'holding :1420' }),
    '- 00:00 feat/x#bbbbbbbb [lock]: holding :1420',
    'keeps the [kind] tag after the session suffix',
  );

  // A short (ppid-fallback) origin is used as-is and still disambiguates.
  assert.equal(
    formatMessage({ ts: 0, origin: '51476', from: 'master', kind: 'note', text: 'x' }),
    '- 00:00 master#51476: x',
    'short numeric origin used verbatim',
  );

  // No origin -> bare branch label, no trailing separator.
  assert.equal(
    formatMessage({ ts: 0, origin: undefined, from: 'master', kind: 'note', text: 'x' }),
    '- 00:00 master: x',
    'no suffix when origin is absent',
  );

  console.log('format test OK');
  process.exitCode = 0;
} catch (e) {
  console.error('format test FAILED:', e.message);
  process.exitCode = 1;
}
