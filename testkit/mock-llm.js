// Scriptable mock LLM server implementing all three protocol flavors:
//   OpenAI  /v1/chat/completions  (SSE streaming + non-streaming + /models)
//   Anthropic /v1/messages        (SSE streaming)
//   Gemini  /v1beta/models/{m}:streamGenerateContent?alt=sse
// Steps are consumed in request order. Used by provider, agent, server, and
// e2e tests — a faithful protocol-level double, not a fake shortcut.
import http from 'node:http';

// Deliberately fake, deliberately not credential-shaped: this value must
// never look like a real provider key (tests assert it appears in headers).
export const DUMMY_KEY = 'dummy-test-key';

export function createMockLlm({ port = 0 } = {}) {
  const steps = [];
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* keep {} */ }
      requests.push({
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        body: parsed,
      });

      const step = steps.length > 0 ? steps.shift() : { content: 'mock: done' };

      if (step.error) {
        res.writeHead(step.error.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(step.error.body ?? { error: { message: step.error.message ?? 'mock error' } }));
        return;
      }

      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
        return;
      }

      if (req.url.includes('/chat/completions')) {
        return respondOpenAi(req, res, parsed, step);
      }
      if (req.url.endsWith('/messages')) {
        return respondAnthropic(req, res, parsed, step);
      }
      if (req.url.includes(':streamGenerateContent') || req.url.includes(':generateContent')) {
        return respondGemini(req, res, parsed, step);
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unknown mock path ${req.url}` } }));
    });
  });

  function chunkify(text, n = 3) {
    if (!text) return [];
    const words = String(text).split(/(\s+)/);
    const chunks = [];
    let cur = '';
    for (const w of words) {
      cur += w;
      if (cur.length >= n) { chunks.push(cur); cur = ''; }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  function sseHead(res) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  }
  const send = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const end = (res) => { res.write('data: [DONE]\n\n'); res.end(); };

  function respondOpenAi(req, res, parsed, step) {
    if (parsed.stream === false || req.headers.accept === 'application/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: 'assistant',
            content: step.content ?? null,
            ...(step.reasoning ? { reasoning_content: step.reasoning } : {}),
            ...(step.tool_calls ? {
              tool_calls: step.tool_calls.map((tc, i) => ({
                id: `call_${i}`, type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
              })),
            } : {}),
          },
          finish_reason: step.tool_calls ? 'tool_calls' : 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      return;
    }
    sseHead(res);
    if (step.reasoning) {
      for (const c of chunkify(step.reasoning, 8)) send(res, { choices: [{ delta: { reasoning_content: c } }] });
    }
    if (step.tool_calls) {
      // split each tool call's JSON arguments across two deltas to exercise assembly
      step.tool_calls.forEach((tc, i) => {
        const args = JSON.stringify(tc.arguments ?? {});
        const mid = Math.floor(args.length / 2);
        send(res, { choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, type: 'function', function: { name: tc.name, arguments: '' } }] } }] });
        send(res, { choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, mid) } }] } }] });
        send(res, { choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] } }] });
      });
    }
    for (const c of chunkify(step.content ?? '')) {
      send(res, { choices: [{ delta: { content: c } }] });
    }
    send(res, { choices: [{ delta: {}, finish_reason: step.tool_calls ? 'tool_calls' : 'stop' }] });
    send(res, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    end(res);
  }

  function respondAnthropic(req, res, parsed, step) {
    sseHead(res);
    send(res, { type: 'message_start', message: { usage: { input_tokens: 12 } } });
    let blockIndex = 0;
    if (step.thinking) {
      send(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking' } });
      for (const c of chunkify(step.thinking, 10)) {
        send(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: c } });
      }
      send(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'signature_delta', signature: 'sig' } });
      send(res, { type: 'content_block_stop', index: blockIndex++ });
    }
    if (step.content) {
      send(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'text' } });
      for (const c of chunkify(step.content, 5)) {
        send(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: c } });
      }
      send(res, { type: 'content_block_stop', index: blockIndex++ });
    }
    for (const tc of step.tool_calls ?? []) {
      const args = JSON.stringify(tc.arguments ?? {});
      send(res, { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: `toolu_${blockIndex}`, name: tc.name } });
      send(res, { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: args } });
      send(res, { type: 'content_block_stop', index: blockIndex++ });
    }
    send(res, { type: 'message_delta', delta: { stop_reason: (step.tool_calls?.length ?? 0) > 0 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 7 } });
    send(res, { type: 'message_stop' });
    res.end();
  }

  function respondGemini(req, res, parsed, step) {
    sseHead(res);
    if (step.thinking) {
      send(res, { candidates: [{ content: { parts: [{ text: step.thinking, thought: true }] } }], usageMetadata: { promptTokenCount: 9, thoughtsTokenCount: 3 } });
    }
    if (step.content) {
      for (const c of chunkify(step.content, 6)) {
        send(res, { candidates: [{ content: { parts: [{ text: c }] } }] });
      }
    }
    if (step.tool_calls?.length) {
      send(res, {
        candidates: [{ content: { parts: step.tool_calls.map((tc) => ({ functionCall: { name: tc.name, args: tc.arguments ?? {} } })) } }],
      });
    }
    send(res, {
      candidates: [{ finishReason: 'STOP', content: { parts: [] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    });
    res.end();
  }

  return {
    steps,
    requests,
    listen: () => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
    address: () => server.address(),
    get url() {
      const a = server.address();
      return `http://127.0.0.1:${a.port}`;
    },
  };
}

// Config patch (deep-merged over defaults) pointing provider "mock" at the server.
export function mockProviderPatch(baseUrl, kind = 'openai', model = 'mock-model') {
  return {
    providers: { mock: { kind, base_url: baseUrl, api_key: DUMMY_KEY, model } },
    default_provider: 'mock',
    default_model: model,
  };
}
