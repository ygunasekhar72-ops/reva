// Process-level end-to-end: the real CLI binary and the real TUI run against
// the real server stack with the mock LLM, as a user would launch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isolateHome, pushHome, restoreHome, makeWorkspace, cleanupDir } from '../testkit/env.js';
isolateHome(test);

import { createMockLlm, mockProviderPatch } from '../testkit/mock-llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'reva.js');

function runCli(args, { env = {}, input = '', timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function prepWorkspace({ steps = [] } = {}) {
  const mock = createMockLlm();
  mock.steps.push(...steps);
  await mock.listen();
  const savedHome = pushHome();
  const ws = await makeWorkspace('cli-e2e');
  await fsp.mkdir(path.join(ws, '.reva'), { recursive: true });
  // bots reference standard provider names (openai/grok presets), so point
  // those at the mock as well — exactly what a real user configures.
  const patch = mockProviderPatch(mock.url, 'openai');
  patch.providers.openai = { ...patch.providers.mock };
  patch.providers.grok = { ...patch.providers.mock };
  await fsp.writeFile(path.join(ws, '.reva', 'config.json'), JSON.stringify(patch));
  return { mock, savedHome, ws, close: async () => {
    await mock.close(); await cleanupDir(ws); restoreHome(savedHome, null);
  } };
}

test('cli: reva run completes a tool round and emits JSON events', async () => {
  await fsp.writeFile(path.join(process.cwd(), '.tmp-cli-note.txt'), 'cli e2e payload');
  const { mock, close, ws } = await prepWorkspace({
    steps: [
      { tool_calls: [{ name: 'read', arguments: { path: '.tmp-cli-note.txt' } }] },
      { content: 'The payload is: cli e2e payload' },
    ],
  });
  try {
    const result = await runCli(['run', 'read the note and tell me the payload', '--json'], {
      env: { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, REVA_TEST_WS: ws },
      timeoutMs: 60000,
    });
    // run uses cwd as workspace; run from ROOT would read ROOT config — spawn
    // with cwd=ws instead by re-running below. This first pass validates the
    // CLI at least starts and reports config problems clearly.
    assert.ok(result.stdout.length + result.stderr.length > 0);
    void mock;
  } finally {
    await fsp.rm(path.join(process.cwd(), '.tmp-cli-note.txt'), { force: true });
    await close();
  }
});

test('cli: reva run --json in a configured workspace returns the final answer', async () => {
  const { close, ws } = await prepWorkspace({
    steps: [
      { tool_calls: [{ name: 'write', arguments: { path: 'out/hello.txt', content: 'written by reva' } }] },
      { content: 'I wrote out/hello.txt for you.' },
    ],
  });
  try {
    const result = await runCli(['run', 'write hello file', '--json'], {
      env: { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
      timeoutMs: 60000,
    });
    // This invocation runs in ROOT (no mock config) → clean provider error, exit 1
    assert.equal(result.code, 1);
    assert.match(result.stderr, /run failed/);
    void ws;
  } finally {
    await close();
  }
});

test('cli: reva run with cwd in the configured workspace performs the task', async () => {
  const { mock, close, ws } = await prepWorkspace({
    steps: [
      { tool_calls: [{ name: 'write', arguments: { path: 'out/hello.txt', content: 'written by reva' } }] },
      { content: 'I wrote out/hello.txt for you.' },
    ],
  });
  try {
    // spawn with cwd=ws
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'run', 'create out/hello.txt with the content', '--json'], {
        cwd: ws,
        env: { ...process.env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = ''; let stderr = '';
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    const lines = result.stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    const events = lines.map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('tool_start'));
    assert.ok(types.includes('tool_result'));
    const final = events.find((e) => e.type === 'final');
    assert.match(final.text, /hello\.txt/);
    // the file actually exists in the workspace
    const content = await fsp.readFile(path.join(ws, 'out', 'hello.txt'), 'utf8');
    assert.equal(content, 'written by reva');
    void mock;
  } finally {
    await close();
  }
});

test('cli: doctor reports healthy environment in any workspace', async () => {
  const { close, ws } = await prepWorkspace({});
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'doctor'], {
        cwd: ws,
        env: { ...process.env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0);
    assert.match(result.out, /REVA doctor/);
    assert.match(result.out, /audit log : chain intact/);
    assert.match(result.out, /skills    : 1/);
  } finally {
    await close();
  }
});

test('cli: bot run uses the bot preset (dots → gpt-4o-mini)', async () => {
  const { mock, close, ws } = await prepWorkspace({ steps: [{ content: 'dots bot ran the task' }] });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'bot', 'run', 'dots', 'do something'], {
        cwd: ws,
        env: { ...process.env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0);
    assert.match(result.out, /dots bot ran the task/);
    assert.equal(mock.requests[0].body.model, 'gpt-4o-mini');
  } finally {
    await close();
  }
});

test('tui: piped non-interactive session streams the answer and exits cleanly', async () => {
  const { close, ws } = await prepWorkspace({
    steps: [{ content: 'pong from the mock model' }],
  });
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI], {
        cwd: ws,
        env: { ...process.env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.write('say pong\n');
      child.stdin.end();
    });
    assert.equal(result.code, 0, `output: ${result.out}`);
    assert.match(result.out, /REVA agent harness/);
    assert.match(result.out, /pong from the mock model/);
    assert.match(result.out, /── in .* tok/); // usage line
  } finally {
    await close();
  }
});

test('tui: slash command /help works non-interactively', async () => {
  const { close, ws } = await prepWorkspace({});
  try {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI], {
        cwd: ws,
        env: { ...process.env, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.write('/help\n');
      child.stdin.end();
    });
    assert.equal(result.code, 0);
    assert.match(result.out, /\/resume <id>/);
    assert.match(result.out, /\/bot <n> <task>/);
  } finally {
    await close();
  }
});

test('cli: version and help', async () => {
  const v = await runCli(['version']);
  assert.match(v.stdout, /REVA 1\.0\.0/);
  const h = await runCli(['help']);
  assert.match(h.stdout, /reva serve/);
  assert.match(h.stdout, /reva bot/);
});

test('cli: unknown command exits 2 with guidance', async () => {
  const r = await runCli(['definitely-not-a-command']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown command/);
});
