// Tool subsystem tests: registry validation + real execution of every tool
// against a real temp workspace (real files, real processes, real guards).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';

import { isolateHome, makeWorkspace, cleanupDir } from '../testkit/env.js';
isolateHome(test);

import { ToolRegistry, ToolError, validateArgs } from '../src/tools/index.js';
import { execTool, runShell } from '../src/tools/exec.js';
import { readTool, writeTool, editTool, listTool, grepTool } from '../src/tools/fs.js';
import { webSearchTool, webFetchTool, parseDuckDuckGoHtml, htmlToText } from '../src/tools/web.js';
import { memorySaveTool, memoryReadTool, todoTool, skillTool } from '../src/tools/memory.js';
import { SkillRegistry } from '../src/skills/index.js';
import { Config } from '../src/core/config.js';

function ctxFor(workspace, overrides = {}) {
  return {
    workspace,
    config: new Config(),
    session: { actor: 'test' },
    mode: 'local',
    emit: () => {},
    audit: null,
    ...overrides,
  };
}

// ---------- registry ----------

test('tool registry: schema validation and normalized errors', async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (args) => ({ text: args.text }),
  });

  const ok = await reg.execute('echo', { text: 'hi' }, { emit: () => {} });
  assert.equal(ok.text, 'hi');

  await assert.rejects(() => reg.execute('echo', {}, {}), /text is required/);
  await assert.rejects(() => reg.execute('echo', { text: 42 }, {}), /must be a string/);
  await assert.rejects(() => reg.execute('nope', {}, {}), /unknown tool/);

  assert.throws(() => reg.register({ name: 'Bad Name!', description: 'x', execute: () => {} }), /invalid tool name/);
  assert.throws(() => reg.register({ name: 'okname', description: '', execute: () => {} }), /needs a description/);
  assert.throws(() => reg.register({ name: 'okname2', description: 'x' }), /needs execute/);

  assert.deepEqual(validateArgs({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 1.5 }).ok, false);
  assert.deepEqual(validateArgs({ type: 'object', properties: { e: { enum: ['a', 'b'] } } }, { e: 'c' }).ok, false);
  assert.deepEqual(
    validateArgs(
      { type: 'object', properties: { arr: { type: 'array', items: { type: 'number' } } } },
      { arr: [1, 'x', 3] },
    ).ok,
    false,
  );
  assert.equal(validateArgs({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 7 }).ok, true);
});

test('tool registry: emits start/result events with timing', async () => {
  const reg = new ToolRegistry();
  reg.register({
    name: 'slowish',
    description: 'x',
    parameters: { type: 'object' },
    execute: async () => {
      await new Promise((r) => setTimeout(r, 15));
      return { text: 'done' };
    },
  });
  const events = [];
  await reg.execute('slowish', {}, { emit: (e) => events.push(e) });
  const start = events.find((e) => e.type === 'tool_start');
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(start.tool, 'slowish');
  assert.ok(start.call_id);
  assert.equal(result.ok, true);
  assert.ok(result.elapsed_ms >= 10);
  // failure path
  reg.register({ name: 'boom', description: 'x', parameters: {}, execute: async () => { throw new Error('kaboom'); } });
  await assert.rejects(() => reg.execute('boom', {}, { emit: (e) => events.push(e) }), /kaboom/);
  const failResult = events.filter((e) => e.type === 'tool_result').at(-1);
  assert.equal(failResult.ok, false);
  assert.equal(failResult.error, 'kaboom');
});

// ---------- exec ----------

test('exec tool: runs real commands in the workspace', async () => {
  const ws = await makeWorkspace('exec');
  const isWin = process.platform === 'win32';
  const command = isWin ? 'echo hello-from-reva' : 'echo hello-from-reva && pwd';
  const result = await execTool.execute({ command }, ctxFor(ws));
  assert.match(result.text, /hello-from-reva/);
  assert.equal(result.exit_code, 0);
});

test('exec tool: timeout kills long-running commands', async () => {
  const isWin = process.platform === 'win32';
  const command = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
  const result = await execTool.execute({ command, timeout_ms: 500 }, ctxFor(await makeWorkspace('exec-timeout')));
  assert.equal(result.timed_out, true);
  assert.ok(result.exit_code !== 0 || result.truncated);
});

test('exec tool: dangerous command needs confirmation; blocked commands never run', async () => {
  const ctx = ctxFor(await makeWorkspace('exec-guard'));
  await assert.rejects(
    () => execTool.execute({ command: 'rm important-file.txt' }, ctx),
    /CONFIRMATION REQUIRED/,
  );
  const okRun = await execTool.execute({ command: 'rm important-file.txt', confirmed: true }, ctx);
  assert.ok('exit_code' in okRun);
  await assert.rejects(() => execTool.execute({ command: 'mkfs.ext4 /dev/sda' }, ctx), /refused/);
  await assert.rejects(
    () => execTool.execute({ command: 'mkfs.ext4 /dev/sda', confirmed: true }, ctx),
    /refused/,
  );
});

test('exec tool: timeout kills the whole process tree (no orphaned grandchild)', async () => {
  const ws = await makeWorkspace('exec-tree');
  // grandchild: writes a marker 3 s after starting, then lingers
  await fs.writeFile(path.join(ws, 'grand.js'),
    "setTimeout(() => require('fs').writeFileSync(process.env.MARKER, '1'), 3000);\n" +
    "setTimeout(() => {}, 20000);\n");
  // child: spawns the grandchild immediately, then stays alive
  await fs.writeFile(path.join(ws, 'child.js'),
    "const cp = require('child_process');\n" +
    "cp.spawn(process.execPath, ['grand.js'], { cwd: __dirname, stdio: 'ignore', env: process.env }).unref();\n" +
    "setTimeout(() => {}, 20000);\n");
  const marker = path.join(ws, 'marker.txt');
  process.env.MARKER = marker;

  const result = await execTool.execute({ command: 'node child.js', timeout_ms: 500 }, ctxFor(ws));
  assert.equal(result.timed_out, true);
  // Give the orphaned grandchild its full window: if tree-kill failed, the
  // marker appears here.
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(marker), false, 'grandchild must have been killed with the tree');
  await cleanupDir(ws);
});

test('exec tool: disabled over the server by default, and via config', async () => {
  const ctxServer = ctxFor(await makeWorkspace('exec-server'), { mode: 'server' });
  await assert.rejects(() => execTool.execute({ command: 'echo x' }, ctxServer), /disabled over the network/);

  const cfg = new Config({});
  cfg.data.tools.exec.enabled = false;
  await assert.rejects(
    async () => execTool.execute({ command: 'echo x' }, ctxFor(await makeWorkspace('exec-disabled'), { config: cfg })),
    /disabled in config/,
  );
});

test('runShell: captures stdout+stderr and exit codes', async () => {
  const isWin = process.platform === 'win32';
  const command = isWin ? 'echo out & echo err 1>&2 & exit /b 3' : 'echo out; echo err 1>&2; exit 3';
  const r = await runShell(command, { cwd: process.cwd(), timeoutMs: 10000 });
  assert.match(r.text, /out/);
  assert.match(r.text, /err/);
  assert.equal(r.exit_code, 3);
});

// ---------- filesystem tools ----------

test('fs tools: write → read → edit → list → grep roundtrip', async () => {
  const ws = await makeWorkspace('fs');
  const ctx = ctxFor(ws);

  const w = await writeTool.execute({ path: 'src/app.js', content: 'const a = 1;\nconsole.log(a);\n' }, ctx);
  assert.match(w.text, /wrote 3 lines/);

  const r = await readTool.execute({ path: 'src/app.js' }, ctx);
  assert.match(r.text, /1  const a = 1;/);
  assert.equal(r.total_lines, 3);

  await editTool.execute({ path: 'src/app.js', old_string: 'const a = 1;', new_string: 'const a = 42;' }, ctx);
  const r2 = await readTool.execute({ path: 'src/app.js' }, ctx);
  assert.match(r2.text, /const a = 42;/);

  const l = await listTool.execute({}, ctx);
  assert.ok(l.entries.some((e) => e.path === 'src/app.js'));

  const g = await grepTool.execute({ pattern: 'const a = 42' }, ctx);
  assert.equal(g.count, 1);
  assert.equal(g.matches[0].file, 'src/app.js');

  // read tool line windowing
  const r3 = await readTool.execute({ path: 'src/app.js', offset: 2, limit: 1 }, ctx);
  assert.match(r3.text, /2\s+console\.log/);

  await cleanupDir(ws);
});

test('fs tools: every path attack is refused', async () => {
  const ws = await makeWorkspace('fs-attacks');
  const ctx = ctxFor(ws);
  await assert.rejects(() => readTool.execute({ path: '../secret.txt' }, ctx), /traversal/);
  await assert.rejects(() => writeTool.execute({ path: '/etc/hosts', content: 'x' }, ctx), /absolute/);
  await assert.rejects(() => editTool.execute({ path: 'C:\\temp\\x.txt', old_string: 'a', new_string: 'b' }, ctx), /absolute/);
  await assert.rejects(() => readTool.execute({ path: 'missing.txt' }, ctx), /does not exist/);
  await assert.rejects(
    () => editTool.execute({ path: 'nowhere.txt', old_string: 'a', new_string: 'b' }, ctx),
    /does not exist/,
  );

  // write a file, then ambiguous edit
  await writeTool.execute({ path: 'dup.txt', content: 'same\nsame\n' }, ctx);
  await assert.rejects(
    () => editTool.execute({ path: 'dup.txt', old_string: 'same', new_string: 'x' }, ctx),
    /matches 2 times/,
  );
  await editTool.execute({ path: 'dup.txt', old_string: 'same', new_string: 'x', replace_all: true }, ctx);
  const r = await readTool.execute({ path: 'dup.txt' }, ctx);
  assert.equal((r.text.match(/x/g) ?? []).length, 2);
  await cleanupDir(ws);
});

// ---------- web tools ----------

function serveOnce(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('web_fetch: fetches a real local page, converts HTML, caps size', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><script>evil()</script><style>.x{}</style></head><body><h1>REVA&nbsp;test</h1><p>paragraph &amp; entity</p></body></html>');
  });
  try {
    const cfg = new Config({});
    cfg.data.tools.web.allow_private_addresses = true; // test-only allowlist
    const result = await webFetchTool.execute({ url: `http://127.0.0.1:${port}/` }, ctxFor(await makeWorkspace('webfetch'), { config: cfg }));
    assert.match(result.text, /REVA test/);
    assert.match(result.text, /paragraph & entity/);
    assert.equal(result.text.includes('evil()'), false);
    assert.equal(result.text.includes('.x{}'), false);
  } finally {
    server.close();
  }
});

test('web_fetch: SSRF guard blocks private targets by default', async () => {
  const ctx = ctxFor(await makeWorkspace('web-ssrf'));
  await assert.rejects(
    () => webFetchTool.execute({ url: 'http://127.0.0.1:1/secret' }, ctx),
    /private address/,
  );
});

test('web_fetch: HTTP errors surface as tool errors', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });
  try {
    const cfg = new Config({});
    cfg.data.tools.web.allow_private_addresses = true;
    await assert.rejects(
      async () => webFetchTool.execute({ url: `http://127.0.0.1:${port}/gone` }, ctxFor(await makeWorkspace('web-404'), { config: cfg })),
      /HTTP 404/,
    );
  } finally {
    server.close();
  }
});

test('ddg html parser: extracts results, decodes uddg links and entities', () => {
  const html = `
  <div class="result">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example &amp; Co</a>
    <a class="result__snippet" href="#">A &quot;great&quot; page &#39;about&#39; stuff</a>
  </div>
  <div class="result">
    <a class="result__a" href="https://direct.example.org/">Direct</a>
    <a class="result__snippet" href="#">second snippet</a>
  </div>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://example.com/page');
  assert.equal(results[0].title, 'Example & Co');
  assert.match(results[0].snippet, /"great" page 'about' stuff/);
  assert.equal(results[1].url, 'https://direct.example.org/');
});

test('web_fetch: redirect hops are re-validated — SSRF bypass via redirect is refused', async () => {
  // Server on 127.0.0.1 redirects to a private address NOT covered by the
  // initial allowlist: the guard must refuse the redirect target.
  const { server, port } = await serveOnce((req, res) => {
    if (req.url === '/bounce') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
      res.end();
      return;
    }
    if (req.url === '/secret') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('TOP SECRET METADATA');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  try {
    const cfg = new Config({});
    // Initial host allowlisted; the redirect target (127.0.0.1) is not.
    cfg.data.tools.web.allowed_hosts = ['localhost'];
    cfg.data.tools.web.allow_private_addresses = false;
    const ctx = ctxFor(await makeWorkspace('web-redirect-ssrf'), { config: cfg });
    await assert.rejects(
      async () => webFetchTool.execute({ url: `http://localhost:${port}/bounce` }, ctx),
      /private address/,
    );
  } finally {
    server.close();
  }
});

test('web_fetch: valid redirect chain is followed and reported', async () => {
  const { server, port } = await serveOnce((req, res) => {
    if (req.url === '/a') {
      res.writeHead(302, { location: '/b' });
      res.end();
    } else if (req.url === '/b') {
      res.writeHead(301, { location: '/c' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('reached the end');
    }
  });
  try {
    const cfg = new Config({});
    cfg.data.tools.web.allow_private_addresses = true;
    const result = await webFetchTool.execute(
      { url: `http://127.0.0.1:${port}/a` },
      ctxFor(await makeWorkspace('web-redirect-ok'), { config: cfg }),
    );
    assert.match(result.text, /reached the end/);
    assert.equal(result.redirects, 2);
  } finally {
    server.close();
  }
});

test('web_fetch: redirect loops are bounded', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(302, { location: '/loop' }); // always redirects to itself
    res.end();
  });
  try {
    const cfg = new Config({});
    cfg.data.tools.web.allow_private_addresses = true;
    await assert.rejects(
      async () => webFetchTool.execute(
        { url: `http://127.0.0.1:${port}/loop` },
        ctxFor(await makeWorkspace('web-redirect-loop'), { config: cfg }),
      ),
      /too many redirects/,
    );
  } finally {
    server.close();
  }
});

test('web_fetch: oversized bodies are truncated during download, not materialized', async () => {
  const { server, port } = await serveOnce((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    // 8 MB in 64 KB chunks — far beyond the 1 MB budget below
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= 128) { clearInterval(timer); res.end(); return; }
      res.write(chunk);
      sent += 1;
    }, 5);
    res.on('close', () => clearInterval(timer));
  });
  try {
    const cfg = new Config({});
    cfg.data.tools.web.allow_private_addresses = true;
    const result = await webFetchTool.execute(
      { url: `http://127.0.0.1:${port}/big`, max_bytes: 1024 * 1024 },
      ctxFor(await makeWorkspace('web-big'), { config: cfg }),
    );
    assert.equal(result.truncated, true);
    assert.ok(result.bytes <= 1024 * 1024 + 64 * 1024, 'read must stop at the budget');
  } finally {
    server.close();
  }
});

test('htmlToText: strips scripts/styles, keeps line structure', () => {
  const text = htmlToText('<div>line1</div><script>bad()</script><p>line2</p><style>.c{}</style><div>line3</div>');
  assert.match(text, /line1/);
  assert.match(text, /line3/);
  assert.equal(text.includes('bad()'), false);
  assert.equal(text.includes('.c{}'), false);
});

// ---------- memory + todo + skill tools ----------

test('memory tools: save, index, read; topic validation', async () => {
  const ws = await makeWorkspace('memory');
  const ctx = ctxFor(ws);
  const events = [];
  const ctxEmit = { ...ctx, emit: (e) => events.push(e) };

  await memorySaveTool.execute({ topic: 'decisions', content: 'we chose sqlite over files' }, ctxEmit);
  await memorySaveTool.execute({ topic: 'gotchas', content: 'win path guards need realpath' }, ctxEmit);

  const read = await memoryReadTool.execute({ topic: 'decisions' }, ctx);
  assert.match(read.text, /sqlite over files/);

  const index = await memoryReadTool.execute({}, ctx);
  assert.match(index.text, /decisions/);
  assert.match(index.text, /gotchas/);

  await assert.rejects(() => memorySaveTool.execute({ topic: '../evil', content: 'x' }, ctx), /topic/);
  await assert.rejects(() => memorySaveTool.execute({ topic: 'ok-topic', content: '' }, ctx), /content/);
  await assert.rejects(() => memoryReadTool.execute({ topic: '../../etc' }, ctx), /invalid topic|not exist/);
  assert.ok(events.some((e) => e.type === 'memory_saved'));
  await cleanupDir(ws);
});

test('todo tool: stores plan on session state and emits', async () => {
  const state = {};
  const events = [];
  const ctx = ctxFor(await makeWorkspace('todo'), {
    session: { setState: (k, v) => { state[k] = v; } },
    emit: (e) => events.push(e),
  });
  const r = await todoTool.execute({ items: [
    { content: 'design', status: 'completed' },
    { content: 'build', status: 'in_progress' },
    { content: 'test', status: 'pending' },
    { content: 'bad status stays pending', status: 'nonsense' },
  ] }, ctx);
  assert.equal(r.items.length, 4);
  assert.equal(r.items[3].status, 'pending');
  assert.deepEqual(state.todos, r.items);
  assert.ok(events.some((e) => e.type === 'todos'));
});

test('skill tool: loads skill bodies, rejects unknown names', async () => {
  const reg = new SkillRegistry({ builtinDir: path.join(process.cwd(), 'skills') });
  await reg.load();
  assert.ok(reg.get('commit'));
  const ctx = ctxFor(await makeWorkspace('skilltool'), { skillRegistry: reg });
  const result = await skillTool.execute({ name: 'commit' }, ctx);
  assert.match(result.text, /# Skill: commit/);
  assert.match(result.text, /heredoc/);
  await assert.rejects(() => skillTool.execute({ name: 'does-not-exist' }, ctx), /not found/);
});

test('read tool: refuses oversized files', async () => {
  const ws = await makeWorkspace('bigfile');
  const big = 'x'.repeat(600 * 1024); // > MAX_READ_BYTES (512KB)
  await fs.writeFile(path.join(ws, 'big.txt'), big);
  await assert.rejects(
    () => readTool.execute({ path: 'big.txt' }, ctxFor(ws)),
    /too large/,
  );
  await cleanupDir(ws);
});
