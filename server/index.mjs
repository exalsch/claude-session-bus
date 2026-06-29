#!/usr/bin/env node
// session-bus MCP server (stdio, JSON-RPC 2.0, newline-delimited).
//
// Exposes two tools to the Claude session that launched it:
//   - broadcast(text, kind?) : append a message to the project mailbox
//   - inbox(limit?)          : read recent peer messages on demand
//
// Hand-rolled (zero dependencies) so the plugin works the moment it is enabled,
// with no `npm install` step. MCP stdio framing is one JSON-RPC message per line.
// If protocol issues ever surface, this can be swapped for @modelcontextprotocol/sdk
// without touching lib/bus.mjs.

import { appendMessage, readMessages, originId } from '../lib/bus.mjs';

const SERVER_INFO = { name: 'claude-session-bus', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2024-11-05';
const KINDS = ['note', 'lock', 'unlock', 'handoff'];

const TOOLS = [
  {
    name: 'broadcast',
    description:
      'Broadcast a short message to all OTHER Claude Code sessions working in this project. ' +
      'They see it prepended to their context before their next turn. One-way and fire-and-forget ' +
      '(no reply comes back). Use for coordination ("editing dynamics.rs"), advisory resource ' +
      'claims ("holding the dev server on :1420"), and handoffs ("branch X pushed, safe to rebase"). ' +
      'Advisory only: it announces, it does not enforce.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The message to broadcast. Keep it short and actionable.',
        },
        kind: {
          type: 'string',
          enum: KINDS,
          description:
            'Optional label. "lock"/"unlock" are advisory resource claims; "handoff" signals work ' +
            'passed to another session; "note" (default) is general awareness.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'inbox',
    description:
      'Read recent broadcasts from OTHER sessions in this project on demand (oldest first, most ' +
      'recent last), without waiting for the next prompt. Read-only: does not advance your unread cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max messages to return (default 20, max 200).' },
      },
    },
  },
];

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) handleLine(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore unparseable frames
  }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case 'notifications/initialized':
      case 'initialized':
        return; // notification - no response
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return result(id, { tools: TOOLS });
      case 'tools/call':
        return handleToolCall(id, params);
      default:
        if (id !== undefined && id !== null) rpcError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (e) {
    if (id !== undefined && id !== null) rpcError(id, -32603, String(e?.message || e));
  }
}

function toolResult(id, text, isError = false) {
  result(id, { content: [{ type: 'text', text }], isError });
}

function fmt(m) {
  const when = new Date(m.ts).toISOString().slice(11, 16); // HH:MM UTC
  const tag = m.kind && m.kind !== 'note' ? ` [${m.kind}]` : '';
  return `- ${when} ${m.from}${tag}: ${m.text}`;
}

function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};

  if (name === 'broadcast') {
    const text = String(args.text || '').trim();
    if (!text) return toolResult(id, 'broadcast: "text" is required', true);
    const kind = KINDS.includes(args.kind) ? args.kind : 'note';
    const msg = appendMessage({ text, kind });
    const label = kind !== 'note' ? ` [${kind}]` : '';
    return toolResult(
      id,
      `Broadcast #${msg.seq} sent as "${msg.from}"${label}. Other sessions in this project will see it before their next turn.`,
    );
  }

  if (name === 'inbox') {
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 20;
    const own = originId();
    const recent = readMessages()
      .filter((m) => String(m.origin) !== own)
      .slice(-limit);
    if (!recent.length) return toolResult(id, 'No broadcasts from other sessions in this project.');
    return toolResult(id, recent.map(fmt).join('\n'));
  }

  return toolResult(id, `Unknown tool: ${name}`, true);
}

process.stderr.write('[session-bus] mcp server ready\n');
