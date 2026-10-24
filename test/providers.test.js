// Provider tests: real HTTP against the protocol-faithful mock LLM — SSE
// streaming, delta assembly, thinking tokens, tool calls, errors, retries,
// key resolution. All three flavors (OpenAI / Anthropic / Gemini).
import test from 'node:test';
import assert from 'node:assert/strict';

import { isolateHome } from '../testkit/env.js';
isolateHome(test);

import { createMockLlm, mockProviderPatch, DUMMY_KEY } from '../testkit/mock-llm.js';
import { ProviderRegistry } from '../src/providers/index.js';
import { ProviderError, ProviderAuthError } from '../src/providers/types.js';
import { Config } from '../src/core/config.js';
import { chatOpenAi, toOpenAiTools, fromInternalMessages } from '../src/providers/openai.js';
import { chatAnthropic, toAnthropicTools, fromInternalMessages as toAnthropicMessages } from '../src/providers/anthropic.js';
import { chatGemini, toGeminiTools, fromInternalMessages as toGeminiMessages } from '../src/providers/gemini.js';

const MESSAGES = [
  { role: 'system', content: 'you are a test agent' },
  { role: 'user', content: 'hello mock' },
];
const TOOLS = [{
  name: 'get_weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}];

async function withMock(kind, fn, steps = []) {
  const mock = createMockLlm();
  mock.steps.push(...steps);
  await mock.listen();
  try {
    const config = new Config({ global: mockProviderPatch(mock.url, kind) });
    const registry = new ProviderRegistry({ config });
    return await fn({ mock, registry, baseUrl: mock.url });
  } finally {
    await mock.close();
  }
}

// ---------- OpenAI flavor ----------

test('openai: streaming text with thinking tokens', async () => {
  await withMock('openai', async ({ mock, registry }) => {
    const events = [];
    const response = await registry.chat('mock', {
      messages: MESSAGES,
      onEvent: (e) => events.push(e),
    });
    assert.equal(response.text, 'plain final answer text');
    assert.equal(response.thinking, 'internal reasoning trace');
    assert.equal(response.stop_reason, 'end_turn');
    assert.deepEqual(response.usage, { input_tokens: 10, output_tokens: 5 });
    const deltas = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    assert.equal(deltas, 'plain final answer text');
    assert.ok(events.some((e) => e.type === 'thinking' && e.delta.includes('reasoning')));
    // auth header was sent
    const req = mock.requests[0];
    assert.equal(req.headers.authorization, `Bearer ${DUMMY_KEY}`);
    assert.equal(req.body.model, 'mock-model');
    assert.equal(req.body.messages[0].role, 'system');
  }, [{ content: 'plain final answer text', reasoning: 'internal reasoning trace' }]);
});

test('openai: tool call assembly from split argument deltas', async () => {
  await withMock('openai', async ({ registry }) => {
    const response = await registry.chat('mock', { messages: MESSAGES, tools: TOOLS });
    assert.equal(response.stop_reason, 'tool_use');
    assert.equal(response.tool_calls.length, 1);
    assert.equal(response.tool_calls[0].name, 'get_weather');
    assert.deepEqual(response.tool_calls[0].arguments, { city: 'Tokyo' });
    assert.match(response.tool_calls[0].id, /^call_/);
  }, [{ tool_calls: [{ name: 'get_weather', arguments: { city: 'Tokyo' } }] }]);
});

test('openai: non-streaming mode works', async () => {
  const mock = createMockLlm();
  mock.steps.push({ content: 'non-streamed reply' });
  await mock.listen();
  try {
    const response = await chatOpenAi({
      apiKey: 'k', baseUrl: mock.url, model: 'm',
      messages: MESSAGES, stream: false,
    });
    assert.equal(response.text, 'non-streamed reply');
  } finally {
    await mock.close();
  }
});

test('openai: 401 fails fast (no retry), 500 retries then succeeds', async () => {
  await withMock('openai', async ({ mock, registry }) => {
    mock.steps.push({ error: { status: 500, body: { error: { message: 'boom' } } } });
    mock.steps.push({ content: 'recovered' });
    const r = await registry.chat('mock', { messages: MESSAGES, maxRetries: 3 });
    assert.equal(r.text, 'recovered');
    assert.equal(mock.requests.length, 2);

    mock.steps.push({ error: { status: 401, body: { error: { message: 'bad key' } } } });
    await assert.rejects(() => registry.chat('mock', { messages: MESSAGES }), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      return true;
    });
    assert.equal(mock.requests.length, 3, '401 must not retry');
  });
});

test('openai: message/tool conversion shapes', () => {
  const converted = fromInternalMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 't', arguments: { a: 1 } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'result' },
  ]);
  assert.equal(converted[0].role, 'system');
  assert.deepEqual(converted[2].tool_calls, [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{"a":1}' } }]);
  assert.deepEqual(converted[3], { role: 'tool', tool_call_id: 'c1', content: 'result' });
  assert.equal(toOpenAiTools(TOOLS)[0].function.name, 'get_weather');
});

// ---------- Anthropic flavor ----------

test('anthropic: streaming with thinking block + tool_use assembly', async () => {
  await withMock('anthropic', async ({ mock, registry }) => {
    const events = [];
    const response = await registry.chat('mock', {
      messages: MESSAGES, tools: TOOLS, onEvent: (e) => events.push(e),
    });
    assert.equal(response.thinking, 'step by step reasoning here');
    assert.equal(response.text, 'visible answer');
    assert.equal(response.stop_reason, 'tool_use');
    assert.equal(response.tool_calls[0].name, 'get_weather');
    assert.deepEqual(response.tool_calls[0].arguments, { city: 'Paris' });
    // anthropic headers
    assert.equal(mock.requests[0].headers['x-api-key'], DUMMY_KEY);
    assert.equal(mock.requests[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(mock.requests[0].body.max_tokens, 8192);
    assert.equal(mock.requests[0].body.system, 'you are a test agent');
    // raw blocks preserved for tool-loop continuity
    const types = response.raw_assistant.content.map((b) => b.type);
    assert.deepEqual(types, ['thinking', 'text', 'tool_use']);
    assert.equal(response.raw_assistant.content[0].signature, 'sig');
  }, [{ thinking: 'step by step reasoning here', content: 'visible answer', tool_calls: [{ name: 'get_weather', arguments: { city: 'Paris' } }] }]);
});

test('anthropic: system extraction + same-role merge + tool results', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 's1' },
    { role: 'system', content: 's2' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tu1', name: 'run', arguments: { x: 2 } }] },
    { role: 'tool', tool_call_id: 'tu1', content: 'r1' },
    { role: 'tool', tool_call_id: 'tu1', content: 'r2' },
  ]);
  assert.equal(system, 's1\n\ns2');
  assert.deepEqual(messages[0], { role: 'user', content: [{ type: 'text', text: 'q' }] });
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content[0].type, 'tool_use');
  assert.equal(messages[1].content[0].input.x, 2);
  // two tool results merged into one user message
  assert.equal(messages[2].role, 'user');
  assert.equal(messages[2].content.length, 2);
  assert.equal(messages[2].content[0].type, 'tool_result');
  assert.equal(toAnthropicTools(TOOLS)[0].input_schema.type, 'object');
});

// ---------- Gemini flavor ----------

test('gemini: streaming with thought summary + functionCall parts', async () => {
  await withMock('gemini', async ({ mock, registry }) => {
    const events = [];
    const response = await registry.chat('mock', {
      messages: MESSAGES, tools: TOOLS, onEvent: (e) => events.push(e),
    });
    assert.equal(response.thinking, 'gemini inner thought');
    assert.equal(response.text, 'gemini says hi');
    assert.equal(response.tool_calls[0].name, 'get_weather');
    assert.deepEqual(response.tool_calls[0].arguments, { city: 'Berlin' });
    assert.equal(mock.requests[0].headers['x-goog-api-key'], DUMMY_KEY);
    assert.equal(mock.requests[0].body.systemInstruction.parts[0].text, 'you are a test agent');
    assert.equal(mock.requests[0].body.tools[0].functionDeclarations[0].name, 'get_weather');
    assert.ok(events.some((e) => e.type === 'thinking'));
  }, [{ thinking: 'gemini inner thought', content: 'gemini says hi', tool_calls: [{ name: 'get_weather', arguments: { city: 'Berlin' } }] }]);
});

test('gemini: role mapping + schema sanitization', () => {
  const { contents } = toGeminiMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'working', tool_calls: [{ id: 'g1', name: 'f', arguments: { z: 1 } }] },
    { role: 'tool', tool_call_id: 'g1', name: 'f', content: 'resp' },
  ]);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  assert.deepEqual(contents[1].parts[1].functionCall, { name: 'f', args: { z: 1 } });
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'f', response: { result: 'resp' } });

  const cleaned = toGeminiTools([{
    name: 'x', description: 'd',
    parameters: { type: 'object', $schema: 'http://x', additionalProperties: false, properties: { a: { type: 'string', maxLength: 10 } }, required: ['a'] },
  }])[0].functionDeclarations[0].parameters;
  assert.equal(cleaned.type, 'OBJECT');
  assert.equal(cleaned.$schema, undefined);
  assert.equal(cleaned.additionalProperties, undefined);
  assert.equal(cleaned.properties.a.type, 'STRING');
});

// ---------- registry ----------

test('registry: key resolution order (keystore > config > env) and auth errors', async () => {
  const config = new Config({
    global: {
      providers: {
        a: { kind: 'openai', base_url: 'http://x', api_key: 'config-key' },
        b: { kind: 'openai', base_url: 'http://x', api_key_env: 'TEST_KEY_B' },
        c: { kind: 'openai', base_url: 'http://x' },
      },
    },
  });
  const registry = new ProviderRegistry({ config, env: { TEST_KEY_B: 'env-key' } });
  assert.equal(registry.resolve('a').apiKey, 'config-key');
  assert.equal(registry.resolve('b').apiKey, 'env-key');
  assert.throws(() => registry.resolve('c'), ProviderAuthError);
  assert.equal(registry.isConfigured('a'), true);
  assert.equal(registry.isConfigured('c'), false);
  assert.throws(() => registry.resolve('nonexistent'), /unknown provider/);

  // keystore wins over config
  const fakeKeystore = {
    unlocked: true,
    getSecret: (name) => (name === 'provider:a' ? 'keystore-key' : undefined),
  };
  const registry2 = new ProviderRegistry({ config, keystore: fakeKeystore });
  assert.equal(registry2.resolve('a').apiKey, 'keystore-key');
});

test('registry: unknown kind and missing model are clean errors', () => {
  const config = new Config({ global: { providers: { broken: { kind: 'nope', base_url: 'http://x', api_key: 'k' } } } });
  const registry = new ProviderRegistry({ config });
  assert.throws(() => registry.resolve('broken'), /unknown kind/);
  const config2 = new Config({ global: { providers: { nomodel: { kind: 'openai', base_url: 'http://x', api_key: 'k' } } } });
  const registry2 = new ProviderRegistry({ config: config2 });
  assert.rejects(
    () => registry2.chat('nomodel', { messages: MESSAGES }),
    /no model specified/,
  );
});

test('registry: listModels via openai-compatible endpoint', async () => {
  await withMock('openai', async ({ registry }) => {
    const models = await registry.listModels('mock');
    assert.deepEqual(models, ['mock-model-a', 'mock-model-b']);
  });
});

test('provider errors: 429 is retryable, carries status', () => {
  const err = new ProviderError('slow down', { status: 429, provider: 'x' });
  assert.equal(err.retryable, true);
  const err2 = new ProviderError('nope', { status: 403, provider: 'x' });
  assert.equal(err2.code, 'auth');
});
