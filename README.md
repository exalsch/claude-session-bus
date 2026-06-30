# claude-session-bus

A tiny Claude Code **plugin** that lets separate Claude sessions working the same
project pass each other short messages: "holding the dev server on :1420", "editing
dynamics.rs", "branch X pushed, safe to rebase".

- **Send** = an MCP tool (`broadcast`) the calling session invokes.
- **Receive** = a `UserPromptSubmit` hook that prepends new peer messages to the other
  session's context before its next turn.
- **Transport** = one append-only JSONL mailbox per project, under
  `${CLAUDE_PROJECT_DIR}/.claude/.session-bus/`.

Broadcast-to-all, one-way, fire-and-forget. Advisory: it announces, it does not enforce.
Project-agnostic - the same install only ever bridges sessions that share a project root.

Full design: [`docs/specs/2026-06-29-claude-session-bus-design.md`](docs/specs/2026-06-29-claude-session-bus-design.md).

## Layout

```
claude-session-bus/
├── .claude-plugin/
│   ├── plugin.json         # plugin manifest: hooks + mcpServers
│   └── marketplace.json    # lets you add this dir as a local marketplace
├── server/index.mjs        # MCP stdio server: broadcast(), inbox()
├── scripts/drain.mjs       # UserPromptSubmit hook (the receive half)
├── scripts/selftest.mjs    # offline smoke test of the mailbox primitives
├── lib/bus.mjs             # shared: paths, identity, locking, message shape
├── hooks/hooks.json        # declares the UserPromptSubmit hook
└── package.json            # type:module, no runtime deps
```

## Quick start

1. **Clone the repo:**

   ```
   git clone https://github.com/exalsch/claude-session-bus.git
   cd claude-session-bus
   ```

2. **Smoke-test the primitives** (no Claude needed):

   ```
   node scripts/selftest.mjs    # expect: selftest OK - { ... }
   ```

3. **Install as a local plugin**, then enable it:

   ```
   /plugin marketplace add /path/to/claude-session-bus    # the directory you just cloned
   /plugin install claude-session-bus@session-bus-dev
   ```

   Restart Claude Code so the MCP server + hook load. Verify the `broadcast` and
   `inbox` tools appear, and that the `session-bus` MCP server is connected.

4. **Use it.** From any session:

   - `broadcast("holding the dev server on :1420", kind="lock")`
   - `inbox()` to re-read peer messages on demand.

   The other session in the same project sees the message prepended to its context the
   next time you submit a prompt there.

## End-to-end test

Open **two** terminals, both `cd` into the *same* project (e.g. `~/projects/your-app`):

1. In session A: ask it to `broadcast("test from A")`.
2. In session B: submit any prompt. B should report a `[session-bus]` line from A.
3. In session A: submit any prompt. A should **not** see its own message (origin filter).

If A *does* see its own message, the `ppid` correlation did not hold (see Risks in the
spec) - the fallback is to render own posts tagged "(you)" instead of filtering them.

## Config

- `SESSION_BUS_BACKFILL_MIN` (default `0`) - minutes of backlog a session sees on its
  first prompt. `0` = forward-only (a new session only sees what arrives after it joins).
- Retention (`MAX_LINES`, `MAX_AGE_MS`) lives in `lib/bus.mjs`.

## Status & next steps

v0.1. The headline risk - **`ppid` correlation on Windows** - was tested and did **not**
hold: Claude Code spawns the `UserPromptSubmit` hook through a shell, so the hook's
parent PID is a transient shell, never the directly-spawned MCP server's PID. Sessions
now correlate on **`CLAUDE_CODE_SESSION_ID`** (an env var both halves inherit from
`claude.exe`) instead of `process.ppid`, with a `ppid` fallback where that var is
absent. Verified end-to-end across two live sessions and covered by
`scripts/test-origin.mjs` (unit) and `scripts/test-drain.mjs` (integration);
`npm test` runs the full suite.

Out of scope today: **cross-project** messaging. The mailbox lives inside each project
(`${CLAUDE_PROJECT_DIR}/.claude/.session-bus/`), so only sessions sharing a project root
bridge. A global bus would need a shared mailbox path plus a `proj` field per message.

This is dev tooling - it must never live inside a product repo.
