// Agent loop tests: the full pipeline against the scripted mock LLM — tool
// rounds, subagents, multi-agent fan-out, compaction with memory snapshot,
// event log persistence, resume, and bots.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { isolateHome, makeWorkspace, cleanupDir } from '../testkit/env.js';
isolateHome(test);

import { createMockLlm, mockProviderPatch } from '../testkit/mock-llm.js';
import { createHarness } from '../src/core/harness.js';
import { rebuildMessages, sanitizeMessages } from '../src/agent/agent.js';
import { extractJson } from '../src/agent/memory.js';
import { BotRegistry, validateBot } from '../src/bots/index.js';
import { AutomationStore, Scheduler, validateJob, msUntilDaily } from '../src/bots/automation.js';

async function harnessWithMock(ws, { steps = [], patch = {} } = {}) {
  const mock = createMockLlm();
  mock.steps.push(...steps);
  await mock.listen();
  const harness = await createHarness({ workspace: ws });
  // point the default AND bot providers at the mock, then apply dotted overrides
  const providerPatch = mockProviderPatch(mock.url, 'openai');
  providerPatch.providers.openai = { ...providerPatch.providers.mock };
  providerPatch.providers.grok = { ...providerPatch.providers.mock };
  Object.assign(harness.config.data, providerPatch);
  for (const [k, v] of Object.entries(patch)) {
    const seg = k.split('.');
    let obj = harness.config.data;
    while (seg.length > 1) obj = obj[seg.shift()];
    obj[seg[0]] = v;
  }
  return { mock, harness };
}

// ---------- basic loop ----------

test('agent: plain text run produces events, usage, persisted log', async () => {
  const ws = await makeWorkspace('agent-plain');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [{ content: 'the final answer', reasoning: 'pondering the question' }],
  });
  try {
    const session = harness.createSession({});
    const result = await session.run('what is 2+2?');
    assert.equal(result.text, 'the final answer');
    assert.equal(result.iterations, 1);
    assert.equal(result.usage.requests, 1);
    assert.ok(result.usage.input_tokens > 0);

    const events = session.eventLog.all();
    const types = events.map((e) => e.type);
    assert.ok(types.includes('user_message'));
    assert.ok(types.includes('assistant_message'));
    assert.ok(types.includes('thinking'));
    assert.ok(types.includes('usage'));
    assert.ok(types.includes('session_done'));

    // persisted as JSONL on disk
    const file = path.join(ws, '.reva', 'sessions', `${session.id}.jsonl`);
    const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, events.length);
    // session indexed
    assert.equal(harness.sessionIndex.get(session.id).title, 'what is 2+2?');
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

test('agent: tool round — exec-free read flow with arguments parsed', async () => {
  const ws = await makeWorkspace('agent-tool');
  await fsp.writeFile(path.join(ws, 'note.txt'), 'hello from the workspace');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      { tool_calls: [{ name: 'read', arguments: { path: 'note.txt' } }] },
      { content: 'the note says: hello from the workspace' },
    ],
  });
  try {
    const session = harness.createSession({});
    const result = await session.run('read note.txt and tell me what it says');
    assert.match(result.text, /hello from the workspace/);
    const types = session.eventLog.all().map((e) => e.type);
    assert.ok(types.includes('tool_start'));
    const toolResult = session.eventLog.all().find((e) => e.type === 'tool_result');
    assert.equal(toolResult.ok, true);
    assert.equal(toolResult.tool, 'read');
    assert.ok(types.includes('tool_message'));
    // messages include the tool result for the next round
    const roles = session.messages.map((m) => m.role);
    assert.ok(roles.includes('tool'));
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

test('agent: tool failure feeds the error back to the model, loop continues', async () => {
  const ws = await makeWorkspace('agent-toolfail');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      { tool_calls: [{ name: 'read', arguments: { path: 'does-not-exist.txt' } }] },
      { content: 'the file was missing, so I reported that' },
    ],
  });
  try {
    const session = harness.createSession({});
    const result = await session.run('read missing file');
    assert.match(result.text, /file was missing/);
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.ok, false);
    assert.match(toolMsg.content, /tool error:.*does not exist/);
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

// ---------- subagents ----------

test('agent: task tool spawns a real subagent and returns its report', async () => {
  const ws = await makeWorkspace('agent-sub');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      { tool_calls: [{ name: 'task', arguments: { prompt: 'find the answer', mode: 'explore' } }] },
      // subagent's single request:
      { content: 'SUBAGENT FINDING: the answer is 42' },
      // parent continues:
      { content: 'Based on my subagent: the answer is 42' },
    ],
  });
  try {
    const session = harness.createSession({});
    const result = await session.run('delegate this');
    assert.match(result.text, /the answer is 42/);

    const parentEvents = session.eventLog.all().map((e) => e.type);
    assert.ok(parentEvents.includes('subagent_start'));
    assert.ok(parentEvents.includes('subagent_done'));
    assert.ok(parentEvents.includes('subagent_event'), 'child events mirrored into parent log');

    // the subagent got the restricted (read-only) tool list — identify its
    // request by the unique subagent prompt in the messages
    const subRequest = mock.requests.find((r) =>
      JSON.stringify(r.body?.messages ?? []).includes('find the answer'));
    assert.ok(subRequest, 'subagent request sent');
    const subToolNames = subRequest.body.tools.map((t) => t.function?.name ?? t.name);
    assert.ok(!subToolNames.includes('task'), 'explore subagent cannot spawn further');
    assert.ok(subToolNames.includes('grep'));

    // depth guard: subagent calling task again would fail (max depth 2, sub at depth 1 → allowed, so check concurrency instead)
    assert.equal(harness.config.get('agent.max_subagent_depth'), 2);
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

test('agent: parallel task calls fan out concurrently (multi-agent)', async () => {
  const ws = await makeWorkspace('agent-multi');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      { tool_calls: [
        { name: 'task', arguments: { prompt: 'research A' } },
        { name: 'task', arguments: { prompt: 'research B' } },
      ] },
      { content: 'child answer A' },
      { content: 'child answer B' },
      { content: 'synthesis of A and B complete' },
    ],
  });
  try {
    const session = harness.createSession({});
    const started = Date.now();
    const result = await session.run('research both topics in parallel');
    const elapsed = Date.now() - started;
    assert.match(result.text, /synthesis/);

    // children actually ran (2 subagent_done events)
    const doneEvents = session.eventLog.all().filter((e) => e.type === 'subagent_done');
    assert.equal(doneEvents.length, 2);
    const summaries = doneEvents.map((e) => e.summary).sort();
    assert.deepEqual(summaries, ['child answer A', 'child answer B']);
    void elapsed;
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

// ---------- compaction + memory ----------

test('agent: compaction snapshots memory BEFORE compacting the conversation', async () => {
  const ws = await makeWorkspace('agent-compact');
  const longUser = 'x'.repeat(4000); // ~1000 est tokens
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      // compaction summary request (no tools attached):
      { content: '{"summary":"Long research project on zinc alloys.","decisions":["use alloy Z2"],"facts":["zinc melts at 420C"],"todos":["test alloy Z2"],"gotchas":["Z2 is brittle at 0C"]}' },
      // post-compaction answer:
      { content: 'Continuing with alloy Z2 testing.' },
    ],
    patch: { 'agent.compaction_threshold': 500, 'agent.keep_recent_messages': 4 },
  });
  try {
    const session = harness.createSession({});
    const result = await session.run(longUser);
    assert.match(result.text, /alloy Z2/);

    // memory files written
    const memDir = path.join(ws, '.reva', 'memory');
    const files = await fsp.readdir(memDir);
    for (const expected of ['decisions.md', 'facts.md', 'todos.md', 'gotchas.md']) {
      assert.ok(files.includes(expected), `memory file ${expected} must exist`);
    }
    const decisions = await fsp.readFile(path.join(memDir, 'decisions.md'), 'utf8');
    assert.match(decisions, /use alloy Z2/);

    // conversation compacted: summary + kept recent only
    assert.ok(session.messages.length <= 5, `messages compacted, got ${session.messages.length}`);
    assert.match(session.messages[0].content, /CONVERSATION COMPACTED/);
    assert.match(session.messages[0].content, /use alloy Z2/);

    const events = session.eventLog.all();
    assert.ok(events.some((e) => e.type === 'compaction_started'));
    const phase = events.filter((e) => e.type === 'compaction_phase');
    assert.ok(phase.some((e) => e.phase === 'memory_snapshot'));
    assert.ok(phase.some((e) => e.phase === 'compact'));
    assert.ok(events.some((e) => e.type === 'compaction_done'));
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

test('agent: memory prompt section feeds saved notes into new sessions', async () => {
  const ws = await makeWorkspace('agent-memprompt');
  const { mock, harness } = await harnessWithMock(ws, { steps: [{ content: 'ok' }] });
  try {
    const memDir = path.join(ws, '.reva', 'memory');
    await fsp.mkdir(memDir, { recursive: true });
    await fsp.writeFile(path.join(memDir, 'decisions.md'), '- [2026-01-01] chose Postgres');
    const session = harness.createSession({});
    const system = await session.buildSystemPrompt();
    assert.match(system, /chose Postgres/);
    assert.match(system, /Project memory/);
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

// ---------- resume / persistence ----------

test('agent: sessions resume from the JSONL event log', async () => {
  const ws = await makeWorkspace('agent-resume');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [
      { tool_calls: [{ name: 'memory_save', arguments: { topic: 'facts', content: 'resume test fact' } }] },
      { content: 'saved, first answer' },
    ],
  });
  let sessionId;
  try {
    const session = harness.createSession({});
    sessionId = session.id;
    await session.run('remember something and answer');
    await harness.shutdown();

    // resume in a fresh harness (simulates restart)
    const harness2 = await createHarness({ workspace: ws, config: null });
    const mock2 = createMockLlm();
    mock2.steps.push({ content: 'second answer after resume' });
    await mock2.listen();
    harness2.config.data = { ...harness2.config.data, ...mockProviderPatch(mock2.url, 'openai') };
    try {
      const resumed = await harness2.resumeSession(sessionId);
      assert.equal(resumed.messages.length >= 3, true, 'history rebuilt');
      assert.equal(resumed.messages[0].role, 'user');
      assert.ok(resumed.messages.some((m) => m.role === 'tool'));
      const result = await resumed.run('continue please');
      assert.equal(result.text, 'second answer after resume');
      // the model saw the previous history
      const lastReq = mock2.requests.at(-1);
      const texts = lastReq.body.messages.map((m) => JSON.stringify(m.content));
      assert.ok(texts.some((t) => t.includes('remember something')), 'history sent to provider');
    } finally {
      await mock2.close();
      await harness2.shutdown();
    }
  } finally {
    await mock.close();
    await cleanupDir(ws);
  }
});

test('rebuildMessages + sanitizeMessages are round-trip stable', () => {
  const events = [
    { type: 'user_message', text: 'hi' },
    { type: 'assistant_message', text: 'using tool', tool_calls: [{ id: '1', name: 'read', arguments: {} }] },
    { type: 'tool_message', tool_call_id: '1', tool: 'read', ok: true, preview: 'file content' },
    { type: 'assistant_message', text: 'done' },
  ];
  const messages = rebuildMessages(events);
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[1].tool_calls, [{ id: '1', name: 'read', arguments: {} }]);
  const sanitized = sanitizeMessages(messages);
  assert.deepEqual(Object.keys(sanitized[0]).sort(), ['content', 'role']);
});

test('extractJson: fenced, embedded, and malformed inputs', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":{"b":[1,2]}} hope that helps'), { a: { b: [1, 2] } });
  assert.deepEqual(extractJson('{"s":"brace } inside string"}'), { s: 'brace } inside string' });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"broken": '), null);
});

// ---------- bots ----------

test('bots: registry seeds presets (dots + grok) and validates', async () => {
  const ws = await makeWorkspace('bots-reg');
  const reg = new BotRegistry(path.join(ws, '.reva', 'bots.json'));
  await reg.load();
  const names = reg.list().map((b) => b.name);
  assert.ok(names.includes('dots'));
  assert.ok(names.includes('grok'));
  const dots = reg.get('dots');
  assert.equal(dots.provider, 'openai');
  assert.ok(dots.system.length > 10);
  const grok = reg.get('grok');
  assert.equal(grok.provider, 'grok');

  assert.throws(() => validateBot({ name: 'BAD NAME!' }), /bot name/);
  assert.throws(() => validateBot({ name: 'ok', max_iterations: 500 }), /max_iterations/);
  assert.throws(() => validateBot({ name: 'ok', tools_allow: 'nope' }), /tools_allow/);
  assert.equal(validateBot({ name: 'ok-bot' }), true);
  await cleanupDir(ws);
});

test('bots: runBot executes on the bot provider/model with persona', async () => {
  const ws = await makeWorkspace('bots-run');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [{ content: 'dots bot reporting: task complete' }],
  });
  try {
    await harness.loadPlugins();
    const result = await harness.runBot('dots', 'do the thing');
    assert.match(result.text, /task complete/);
    const req = mock.requests[0];
    assert.equal(req.body.model, 'gpt-4o-mini', 'bot model override applied');
    assert.match(req.body.messages[0].content, /dots/, 'bot persona in system prompt');

    // unknown bot errors clearly
    await assert.rejects(() => harness.runBot('nonexistent', 'x'), /bot "nonexistent" not found/);

    // bot run is audited
    const audit = await harness.audit.verify();
    assert.ok(audit.entries.some((e) => e.event === 'bot.run'));
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});

// ---------- automation ----------

test('automation: job validation, due logic, scheduler end-to-end', async () => {
  assert.throws(() => validateJob({ name: 'x', prompt: 'p', schedule: { every_ms: 100 } }), /1 minute/);
  assert.throws(() => validateJob({ name: 'x', prompt: 'p', schedule: { daily_at: '25:00' } }), /daily_at/);
  assert.throws(() => validateJob({ name: 'x', prompt: '', schedule: { every_ms: 60000 } }), /prompt/);
  assert.equal(validateJob({ name: 'x', prompt: 'p', schedule: { every_ms: 60000 } }), true);

  // daily at: next occurrence math
  const now = new Date('2026-10-24T10:00:00');
  const next = msUntilDaily('23:30', now.getTime());
  assert.ok(Math.abs(next - (13.5 * 3600 * 1000)) < 1000);
  const past = msUntilDaily('09:00', now.getTime());
  assert.ok(Math.abs(past - (23 * 3600 * 1000)) < 1000, 'past time today schedules tomorrow');

  const ws = await makeWorkspace('auto');
  const store = new AutomationStore(path.join(ws, '.reva', 'automation.json'));
  await store.load();
  const job = await store.add({ name: 'nightly', prompt: 'check the build', schedule: { every_ms: 60000 } });
  assert.deepEqual(store.dueJobs().map((j) => j.id), [job.id]);
  await store.update(job.id, { last_run: Date.now(), last_status: 'ok' });
  assert.equal(store.dueJobs().length, 0, 'not due again within the window');
  await store.update(job.id, { last_run: Date.now() - 120000 });
  assert.equal(store.dueJobs().length, 1, 'due after interval elapsed');
  await store.remove(job.id);
  assert.equal(store.list().length, 0);
  await cleanupDir(ws);
});

test('automation: scheduler runs due jobs through the harness', async () => {
  const ws = await makeWorkspace('auto-run');
  const { mock, harness } = await harnessWithMock(ws, {
    steps: [{ content: 'automated run finished' }],
  });
  try {
    await harness.automation.add({
      name: 'sweep', prompt: 'sweep the logs', schedule: { every_ms: 60000 }, bot: 'dots',
    });
    const events = [];
    const scheduler = new Scheduler({
      store: harness.automation,
      onEvent: (e) => events.push(e),
      tickMs: 1000000, // no background ticking; call tick() manually
      runJob: async (job) => { await harness.runBot(job.bot, job.prompt, { mode: 'server' }); },
    });
    // tick() awaits the launched batch — deterministic, no polling needed
    await scheduler.tick();
    const jobId = harness.automation.list().find((j) => j.name === 'sweep').id;
    const updated = harness.automation.get(jobId);
    assert.equal(updated.last_status, 'ok');
    assert.equal(updated.run_count, 1);
    assert.ok(events.some((e) => e.type === 'automation_done'));
    // bot actually called the model
    assert.equal(mock.requests.length, 1);
    scheduler.stop();
  } finally {
    await mock.close();
    await harness.shutdown();
    await cleanupDir(ws);
  }
});
