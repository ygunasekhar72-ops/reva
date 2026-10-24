#!/usr/bin/env node
// A real MCP server (JSON-RPC 2.0 over stdio, newline-delimited) used by the
// MCP client tests. Provides: echo, add, slow (sleeps TOOL_DELAY_MS ms).
// Flags: --crash-after-init exits right after the initialize response;
//        --crash-on-request <method> dies with that request pending.
let buffer = '';
let crashAfterInit = process.argv.includes('--crash-after-init');
let crashMethod = null;
const crashIdx = process.argv.indexOf('--crash-on-request');
if (crashIdx !== -1) crashMethod = process.argv[crashIdx + 1];
const delayMs = Number(process.env.TOOL_DELAY_MS ?? 0);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on('end', () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleMessage(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // notification: ignore
  if (crashMethod && msg.method === crashMethod) {
    // die with the request pending — no response ever arrives
    process.exit(7);
  }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '1.0.0' },
      },
    });
    if (crashAfterInit) {
      setTimeout(() => process.exit(7), 10);
    }
    return;
  }
  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the input text.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
          {
            name: 'add',
            description: 'Add two numbers.',
            inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
          },
          {
            name: 'slow',
            description: 'Sleeps then returns. Used for timeout tests.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    const respond = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
    if (name === 'echo') respond({ content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] });
    else if (name === 'add') respond({ content: [{ type: 'text', text: String((args?.a ?? 0) + (args?.b ?? 0)) }] });
    else if (name === 'slow') setTimeout(() => respond({ content: [{ type: 'text', text: 'finally done' }] }), delayMs);
    else respond({ isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
}

// Keep alive even when stdin pauses.
setInterval(() => {}, 60000);
