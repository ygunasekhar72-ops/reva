// MCP client tests against a real MCP server process (JSON-RPC 2.0 over stdio).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isolateHome } from '../testkit/env.js';
isolateHome(test);

import { McpClient, McpManager, McpError } from '../src/mcp/client.js';
import { Config } from '../src/core/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'testkit', 'mock-mcp-server.js');

function clientFor(extra = {}) {
  return new McpClient({
    name: 'mock',
    command: process.execPath,
    args: [SERVER],
    timeoutMs: 5000,
    ...extra,
  });
}

test('mcp: initialize handshake + tools/list', async () => {
  const client = clientFor();
  try {
    const init = await client.start();
    assert.equal(client.status, 'running');
    assert.equal(init.serverInfo.name, 'mock-mcp');
    const tools = await client.listTools();
    assert.equal(tools.length, 3);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['mcp__mock__add', 'mcp__mock__echo', 'mcp__mock__slow'],
    );
    const echo = tools.find((t) => t.name === 'mcp__mock__echo');
    assert.equal(echo.mcp, true);
    assert.equal(echo.mcp_server, 'mock');
    assert.equal(echo.parameters.required[0], 'text');
  } finally {
    await client.stop();
  }
});

test('mcp: tools/call roundtrip', async () => {
  const client = clientFor();
  try {
    await client.start();
    await client.listTools();
    const echo = await client.callTool('echo', { text: 'hello mcp' });
    assert.equal(echo.ok, true);
    assert.equal(echo.content, 'echo: hello mcp');
    const add = await client.callTool('add', { a: 19, b: 23 });
    assert.equal(add.content, '42');
  } finally {
    await client.stop();
  }
});

test('mcp: tool error surfaces as isError result', async () => {
  const client = clientFor();
  try {
    await client.start();
    const result = await client.callTool('nonexistent-tool', {});
    assert.equal(result.ok, false);
    assert.match(result.content, /unknown tool/);
  } finally {
    await client.stop();
  }
});

test('mcp: request timeout is enforced', async () => {
  const client = clientFor({ env: { TOOL_DELAY_MS: '1500' } });
  try {
    await client.start();
    await client.listTools();
    await assert.rejects(
      () => client.callTool('slow', {}, { timeoutMs: 250 }),
      (err) => {
        assert.equal(err.code, 'etimeout');
        assert.match(err.message, /timed out/);
        return true;
      },
    );
    // a generous timeout lets the slow tool complete
    const ok = await client.callTool('slow', {}, { timeoutMs: 5000 });
    assert.equal(ok.content, 'finally done');
  } finally {
    await client.stop();
  }
});

test('mcp: server crash with a pending request rejects deterministically', async () => {
  const client = clientFor({ args: [SERVER, '--crash-on-request', 'tools/list'] });
  await client.start();
  await assert.rejects(
    () => client.listTools(),
    (err) => {
      assert.match(err.message, /exited \(code 7\)/);
      return true;
    },
  );
  assert.equal(client.status, 'stopped');
});

test('mcp: calling without a running server fails cleanly', async () => {
  const client = clientFor();
  await assert.rejects(() => client.request('tools/list', {}), /not running/);
  await client.stop(); // no-op when stopped
});

test('mcp manager: connectAll + namespaced tools + call dispatch', async () => {
  const config = new Config({
    global: {
      mcp: {
        servers: {
          good: { command: process.execPath, args: [SERVER] },
          broken: { command: process.execPath, args: [SERVER, '--crash-on-request', 'tools/list'] },
          ghost: { command: 'definitely-not-a-real-binary-xyz', args: [] },
        },
      },
    },
  });
  const manager = new McpManager({ config, cwd: process.cwd() });
  try {
    const results = await manager.connectAll();
    assert.equal(results.good.ok, true);
    assert.equal(results.good.tools, 3);
    assert.equal(results.broken.ok, false);
    assert.equal(results.ghost.ok, false);

    const tools = manager.allTools();
    assert.equal(tools.length, 3);
    assert.ok(tools.every((t) => t.name.startsWith('mcp__good__')));

    const res = await manager.call('mcp__good__add', { a: 2, b: 3 });
    assert.equal(res.content, '5');

    await assert.rejects(() => manager.call('mcp__good__missing', {}), McpError);
    const status = manager.status();
    assert.equal(status[0].name, 'good');
  } finally {
    await manager.stopAll();
  }
});

test('mcp manager: disabled server refuses connect; unknown server errors', async () => {
  const config = new Config({
    global: {
      mcp: {
        servers: { off: { command: process.execPath, args: [SERVER], enabled: false } },
      },
    },
  });
  const manager = new McpManager({ config, cwd: process.cwd() });
  await assert.rejects(() => manager.connect('off'), /disabled/);
  await assert.rejects(() => manager.connect('unknown'), /no MCP server configured/);
});
