# claude-session-bus - design

Status: approved (brainstormed 2026-06-29). v0.1 scaffolded; pending the spike validation in "Risks".

## Problem

When several Claude Code sessions work the same project at once (multiple terminals,
worktrees, a shared checkout that gets branch-switched), they are blind to each other.
One session starts the dev server while another already holds the port; two sessions
edit the same file; a session finishes a push and the other has no idea it can rebase.
There is no built-in way for separate top-level sessions to exchange a quick word.

This is distinct from subagents within one session (those already have SendMessage).
We want **separate, peer Claude Code sessions in the same project** to pass short
coordination messages.

## Scope (decided)

- **Use cases:** coordination / advisory locks, and handoff / notify. Both one-way.
- **Addressing:** broadcast to all. No targeting, no nicknames, no registration.
- **Delivery timing:** at the receiver's `UserPromptSubmit` only (before its next turn).
  No `Stop`/`SessionStart` delivery - non-intrusive by choice.
- **Packaging:** a single, project-agnostic Claude Code plugin bundling an MCP server
  (the send tool) + a `UserPromptSubmit` hook (the receive half).
- **Lives outside any product repo.** Keys its mailbox off `CLAUDE_PROJECT_DIR`, so the
  same plugin serves every project and only ever bridges sessions sharing a project root.

### Explicitly out of scope (YAGNI)

Request/response or any reply path; enforced locks (claims are advisory only);
`Stop`/`SessionStart` delivery; directed addressing / nicknames; a cross-project bus;
durable history beyond a rolling window.

## Architecture

One plugin, three pieces, one project-scoped mailbox.

### 1. MCP server (`session-bus`) - the send tool

Single-file Node stdio server, **zero dependencies** (hand-rolled JSON-RPC so the
plugin works the instant it is enabled, no `npm install`). Tools:

- `broadcast(text, kind?)` - append a message to the mailbox. `kind` is a scannable
  label only: `note | lock | unlock | handoff`. **Locks are advisory announcements,
  not enforced mutexes.** Returns the assigned seq.
- `inbox(limit?)` - re-read recent peer messages on demand without waiting for a prompt.
  Read-only; does not move the cursor.

### 2. `UserPromptSubmit` hook (`drain`) - the receive half

On every prompt: read `session_id` / `cwd` from stdin, read the mailbox, emit messages
that are (a) newer than this session's cursor and (b) **not** from this session's origin,
as `hookSpecificOutput.additionalContext`, then advance the cursor. Any failure exits 0
with no output - it must never block a prompt.

### 3. Mailbox (state)

Under `${CLAUDE_PROJECT_DIR}/.claude/.session-bus/` (git-ignored in target projects):

- `mailbox.jsonl` - append-only broadcast log, rolling window (≤500 lines, ≤24h).
- `seq` - monotonic counter (separate file, so trimming never reuses ids).
- `cursors/<session_id>.json` - per-session read position.
- `.lock` - advisory lock dir (atomic `mkdir`, stale-broken after 10s).

## Data model

```json
{ "seq": 42, "ts": 1719640000000, "origin": "12345", "from": "feat/foo", "kind": "lock", "text": "holding :1420" }
```

- `seq` - ordering key; the cursor stores the last `seq` a session has consumed.
- `origin` - `process.ppid`: the Claude session's PID. See "Identity" below.
- `from` - human label: git branch of the project dir, else the dir name.

## Identity (the crux)

The MCP server and the hook are **separate processes** and Claude Code does **not** pass
the session id to MCP servers (it passes it only to hooks, on stdin). So the two halves
of one session cannot share identity via session-id.

The shared key we use is **parent PID**: both the MCP server and the hook are spawned by
the same Claude Code process, so `process.ppid` is identical within a session and differs
across sessions. The sender stamps `origin = ppid`; the receiver filters out messages
whose `origin` equals its own `ppid`. The cursor itself is keyed by `session_id` (which
the hook does have).

## Data flow

```
Claude A: broadcast("holding :1420", kind=lock)
  -> lib appends {seq, origin=A_ppid, from=branchA, ...} to mailbox.jsonl
Claude B: submits any prompt
  -> drain hook reads mailbox, sees seq > B.cursor and origin != B_ppid
  -> prepends "[bus] feat/foo [lock]: holding :1420" to B's context
  -> advances B.cursor
Claude A: never sees its own line (origin == A_ppid)
```

## Build order

0. **Spike** - confirm the plugin loads MCP + hook together, the hook injects context,
   and `ppid` correlation holds on Windows (see Risks). `node scripts/selftest.mjs`
   covers the mailbox primitives offline.
1. MCP `broadcast` / `inbox`.
2. Drain hook + cursor.
3. Two-terminal end-to-end test in a real project.

## Risks / open questions

- **ppid correlation (primary risk).** If Claude Code runs the hook command through a
  shell on Windows, the hook's parent may be that shell rather than the Claude process,
  so its `ppid` would not match the MCP server's. Validate in the spike. **Fallback:** if
  they do not match, drop self-filtering and instead render a session's own posts tagged
  "(you)" - mildly noisy but fully correct, and a one-line change in `drain.mjs`.
- **Append atomicity.** Short single-line appends under the `mkdir` lock; partial lines
  are tolerated by the JSONL reader. Fine for this volume.
- **First-sight backlog.** Forward-only by default (cursor parks at the tail). Knob:
  `SESSION_BUS_BACKFILL_MIN` shows a recent window on a session's first prompt.

## Knobs

- `SESSION_BUS_BACKFILL_MIN` (default `0`) - minutes of backlog to show on first sight.
- Retention constants `MAX_LINES` / `MAX_AGE_MS` in `lib/bus.mjs`.
