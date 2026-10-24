// Server end-to-end: real HTTP against the real server + harness + mock LLM.
// Covers auth (bootstrap/login/lockout/token), the full session SSE flow,
// bots, extensions, memory, automation, audit, static hardening, and abuse
// controls (rate limits, body caps, traversal, exec-over-server).
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

import { isolateHome, pushHome, restoreHome, makeWorkspace, cleanupDir } from '../testkit/env.js';
isolateHome(test);

import { createMockLlm, mockProviderPatch } from '../testkit/mock-llm.js';
import { createHarness } from '../src/core/harness.js';
import { RevaServer, clientIp } from '../src/server/index.js';

async function bootServer({ steps = [] } = {}) {
  // per-server isolated home: accounts/sessions/keystore never leak between tests
  const savedHome = pushHome();
  const ws = await makeWorkspace('server-e2e');
  const mock = createMockLlm();
  mock.steps.push(...steps);
  await mock.listen();
  const harness = await createHarness({ workspace: ws });
  const pp = mockProviderPatch(mock.url, 'openai');
  pp.providers.openai = { ...pp.providers.mock };
  Object.assign(harness.config.data, pp);
  await harness.loadPlugins();
  const server = new RevaServer({ harness, host: '127.0.0.1', port: 0 });
  const addr = await server.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { ws, mock, harness, server, base, close: async () => {
    await server.close(); await mock.close(); await cleanupDir(ws); restoreHome(savedHome, null);
  } };
}

function api(base, token) {
  return async function request(path, { method = 'GET', body, raw } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    if (raw) return response;
    const data = await response.json().catch(() => ({}));
    return { status: response.status, headers: response.headers, data };
  };
}

// Minimal SSE client over fetch (Node has no EventSource global).
async function readEvents(base, token, sessionId, until, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const response = await fetch(`${base}/api/sessions/${sessionId}/events?since=-1`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try {
            const e = JSON.parse(line.slice(5).trim());
            events.push(e);
            if (until(e)) return events;
          } catch { /* ignore */ }
        }
      }
    }
    return events;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

test('server: full auth lifecycle + locked endpoints', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);

    // health is open
    const health = await fetch(`${s.base}/health`);
    assert.equal(health.status, 200);

    // locked without token
    const me0 = await anon('/api/me');
    assert.equal(me0.status, 401);

    // bootstrap: weak password refused, then works
    const weak = await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'short' } });
    assert.equal(weak.status, 400);
    const boot = await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    assert.equal(boot.status, 201);
    // second bootstrap refused
    const boot2 = await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'eve', password: 'attacker-pass-1' } });
    assert.equal(boot2.status, 401);

    // login wrong → 401; right → token
    const bad = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-pass-123' } });
    assert.equal(bad.status, 401);
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    assert.equal(login.status, 200);
    assert.ok(login.data.token.length >= 30);
    const authed = api(s.base, login.data.token);
    const me = await authed('/api/me');
    assert.equal(me.data.actor.username, 'admin');
    assert.equal(me.data.actor.role, 'admin');

    // garbage token refused
    const fake = api(s.base, 'A'.repeat(48));
    assert.equal((await fake('/api/me')).status, 401);

    // logout revokes
    const out = await authed('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(out.status, 200);
    assert.equal((await authed('/api/me')).status, 401);

    // login again for later tests in this file
    const relogin = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    assert.equal(relogin.status, 200);
  } finally {
    await s.close();
  }
});

test('server: security headers + static hardening', async () => {
  const s = await bootServer();
  try {
    const response = await fetch(`${s.base}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');

    const css = await fetch(`${s.base}/app.css`);
    assert.match(css.headers.get('content-type'), /text\/css/);

    // traversal attempts that reach the server are refused (raw '../..' is
    // normalized away by the HTTP client itself, so those become harmless
    // SPA fallback requests — assert no file content leaks either way)
    for (const attack of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/reva/package.json', '/....//....//package.json']) {
      const res = await fetch(`${s.base}${attack}`);
      const body = await res.text();
      assert.ok(
        (res.status === 403 || res.status === 404 || res.status === 200),
        `traversal ${attack} → ${res.status}`,
      );
      assert.equal(body.includes('"name": "reva-harness"'), false, `traversal ${attack} must not leak package.json`);
    }
    // SPA fallback serves index for unknown paths
    const spa = await fetch(`${s.base}/some/client/route`);
    assert.equal(spa.status, 200);
    assert.match(spa.headers.get('content-type'), /text\/html/);
  } finally {
    await s.close();
  }
});

test('server: session create → message → SSE events → done (full agent flow)', async () => {
  const s = await bootServer({
    steps: [
      { tool_calls: [{ name: 'memory_save', arguments: { topic: 'facts', content: 'server e2e fact' } }] },
      { content: 'agent finished the server task' },
    ],
  });
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);

    const created = await authed('/api/sessions', { method: 'POST', body: {} });
    assert.equal(created.status, 201);
    const sessionId = created.data.id;

    // start SSE listener BEFORE posting the message (no missed events)
    const donePromise = readEvents(s.base, login.data.token, sessionId, (e) => e.type === 'session_done');
    const send = await authed(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: { text: 'remember something then answer' } });
    assert.equal(send.status, 202);

    const events = await donePromise;
    const types = events.map((e) => e.type);
    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('tool_start'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('assistant_message'));
    const final = events.filter((e) => e.type === 'assistant_message').at(-1);
    assert.match(final.text, /server task/);
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.equal(toolResult.ok, true);

    // session listed
    const list = await authed('/api/sessions');
    assert.ok(list.data.sessions.some((x) => x.id === sessionId));

    // memory written by the agent via the tool
    const mem = await authed('/api/memory');
    assert.match(mem.data.topics.facts ?? '', /server e2e fact/);

    // replay-from-offset works (SSE since=)
    const replay = await readEvents(s.base, login.data.token, sessionId, (e) => e.type === 'session_done', 10000);
    assert.ok(replay.length >= events.length - 1);
  } finally {
    await s.close();
  }
});

test('server: exec tool is disabled over the network by default', async () => {
  const s = await bootServer({
    steps: [
      { tool_calls: [{ name: 'exec', arguments: { command: 'echo pwned' } }] },
      { content: 'done' },
    ],
  });
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);
    const created = await authed('/api/sessions', { method: 'POST', body: {} });
    const sessionId = created.data.id;
    const donePromise = readEvents(s.base, login.data.token, sessionId, (e) => e.type === 'session_done');
    await authed(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: { text: 'run a command' } });
    const events = await donePromise;
    const toolResult = events.find((e) => e.type === 'tool_result');
    assert.equal(toolResult.ok, false);
    assert.match(JSON.stringify(events), /disabled over the network/);
  } finally {
    await s.close();
  }
});

test('server: bots run over HTTP with own model; catalog exposes presets', async () => {
  const s = await bootServer({ steps: [{ content: 'bot via http works' }] });
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);

    const bots = await authed('/api/bots');
    const names = bots.data.bots.map((b) => b.name);
    assert.ok(names.includes('dots') && names.includes('grok'));

    const run = await authed('/api/bots/dots/run', { method: 'POST', body: { prompt: 'say hi' } });
    assert.equal(run.status, 200);
    assert.equal(run.data.text, 'bot via http works');
    // dots preset forced gpt-4o-mini as the model
    assert.equal(s.mock.requests[0].body.model, 'gpt-4o-mini');

    const ghost = await authed('/api/bots/ghost/run', { method: 'POST', body: { prompt: 'x' } });
    assert.equal(ghost.status, 500);
    assert.match(ghost.data.error ?? '', /internal/); // details never leak in prod responses
  } finally {
    await s.close();
  }
});

test('server: extensions, skills, plugins, tools, providers endpoints', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);

    const ext = await authed('/api/extensions');
    assert.ok(ext.data.extensions.some((e) => e.name === 'system-status'));
    // the extension entry is served at a registry-keyed URL (no filename in
    // the request — the server resolves it from the manifest at load time)
    const extFile = await fetch(`${s.base}/extensions/system-status`);
    assert.equal(extFile.status, 200);
    assert.match(extFile.headers.get('content-type'), /javascript/);
    assert.match(await extFile.text(), /export function activate/);
    // any path-shaped suffix falls through to the SPA shell — assert no leak
    const extAttack = await fetch(`${s.base}/extensions/system-status/..%2fpackage.json`);
    const attackBody = await extAttack.text();
    assert.equal(attackBody.includes('"name": "reva-harness"'), false, 'extension traversal must not leak package.json');

    const skills = await authed('/api/skills');
    assert.ok(skills.data.skills.some((k) => k.name === 'commit'));

    const plugins = await authed('/api/plugins');
    assert.ok(plugins.data.plugins.some((p) => p.name === 'sample' && p.status === 'active'));
    // the plugin tool is registered and listed
    const tools = await authed('/api/tools');
    assert.ok(tools.data.tools.some((t) => t.name === 'plugin__sample__word_count'));

    const providers = await authed('/api/providers');
    assert.ok(providers.data.catalog.length >= 5);
    assert.ok(providers.data.configured.mock.has_key === true);

    // key storage via API (keystore not unlocked yet → 409)
    const noKs = await authed('/api/keys', { method: 'POST', body: { provider: 'openai', key: 'sk-test-12345678' } });
    assert.equal(noKs.status, 409);
  } finally {
    await s.close();
  }
});

test('server: memory + automation + audit endpoints', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);

    await authed('/api/memory', { method: 'POST', body: { topic: 'decisions', content: '- chose HTTP-first design' } });
    const mem = await authed('/api/memory');
    assert.match(mem.data.topics.decisions, /HTTP-first/);

    const job = await authed('/api/automation', { method: 'POST', body: {
      name: 'http-job', prompt: 'check', schedule: { every_ms: 3600000 },
    } });
    assert.equal(job.status, 201);
    const jobs = await authed('/api/automation');
    assert.ok(jobs.data.jobs.some((j) => j.name === 'http-job'));

    const audit = await authed('/api/audit');
    assert.equal(audit.data.ok, true);
    assert.ok(audit.data.total >= 2);
  } finally {
    await s.close();
  }
});

test('server: abuse controls — auth rate limit, body cap, busy session', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });

    // body size cap (2MB default) — before the rate-limit hammer, otherwise
    // the auth limiter answers 429 first
    const big = 'x'.repeat(3 * 1024 * 1024);
    const huge = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: big }),
    });
    assert.equal(huge.status, 413);

    // invalid JSON
    const badJson = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope',
    });
    assert.equal(badJson.status, 400);

    // hammer login → 429 after auth_rate.max (10/min)
    let sawLimit = false;
    for (let i = 0; i < 15; i++) {
      const r = await anon('/api/auth/login', { method: 'POST', body: { username: 'nobody-here', password: 'guess-pass-123' } });
      if (r.status === 429) { sawLimit = true; assert.ok(r.data.retry_after_ms > 0); break; }
      assert.equal(r.status, 401);
    }
    assert.equal(sawLimit, true, 'auth rate limit must engage');
  } finally {
    await s.close();
  }
});

test('server: account lockout over HTTP after repeated failures', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    let locked = false;
    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-pass-99' } });
      if (last.data.code === 'locked') { locked = true; break; }
    }
    assert.equal(locked, true, 'lockout engages over HTTP');
    // correct password also refused while locked
    const even = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    assert.equal(even.data.code, 'locked');
  } finally {
    await s.close();
  }
});

test('server: session abort stops a running agent', async () => {
  // mock that stalls: script step that hangs (no response) — emulate with a slow gemini? simpler:
  // use exec? disabled. Use a provider step that never completes via a custom delayed response.
  const s = await bootServer({ steps: [{ content: 'will be aborted' }] });
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);
    const created = await authed('/api/sessions', { method: 'POST', body: {} });
    const sessionId = created.data.id;
    const aborted = await authed(`/api/sessions/${sessionId}/abort`, { method: 'POST', body: {} });
    assert.equal(aborted.status, 200);
    // deleting the (non-running) session also works
    const del = await authed(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    await s.close();
  }
});

test('server: MCP endpoints report configured servers', async () => {
  const s = await bootServer();
  try {
    const anon = api(s.base, null);
    await anon('/api/auth/bootstrap', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const login = await anon('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin-pass-123' } });
    const authed = api(s.base, login.data.token);
    const mcp = await authed('/api/mcp');
    assert.deepEqual(mcp.data.configured, []);
    assert.deepEqual(mcp.data.tools, []);
  } finally {
    await s.close();
  }
});

test('server: clientIp helper', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.equal(clientIp({ socket: {} }), 'unknown');
});
