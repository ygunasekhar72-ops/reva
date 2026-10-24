// OpenAI-compatible provider: /chat/completions with SSE streaming, tool
// calls, reasoning_content passthrough (DeepSeek/o-series style). Also serves
// Grok (x.ai), DeepSeek, OpenRouter, Ollama, LM Studio, and any compatible
// endpoint.
import { ProviderError, STOP } from './types.js';
import { sseLines, readJsonResponse } from './sse.js';

export function toOpenAiTools(tools) {
  return (tools ?? []).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
  }));
}

export function fromInternalMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') };
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        })),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

const FINISH_MAP = {
  stop: STOP.END,
  length: STOP.LENGTH,
  tool_calls: STOP.TOOL,
  function_call: STOP.TOOL,
  content_filter: STOP.END,
};

export async function chatOpenAi({ apiKey, baseUrl, model, messages, tools, temperature, signal, onEvent, maxTokens, extraHeaders, stream = true }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    messages: fromInternalMessages(messages),
    temperature,
    stream,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (tools && tools.length > 0) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = 'auto';
  }
  if (stream) body.stream_options = { include_usage: true };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`network error: ${err.message}`, { provider: 'openai', retryable: true });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(`HTTP ${response.status}: ${detail.slice(0, 500)}`, {
      provider: 'openai', status: response.status,
    });
  }

  const state = {
    text: '',
    thinking: '',
    toolCalls: [], // assembled by index
    usage: { input_tokens: 0, output_tokens: 0 },
    finish: STOP.END,
  };

  if (!stream) {
    const json = await readJsonResponse(response);
    const choice = json.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    state.text = msg.content ?? '';
    if (msg.reasoning_content) state.thinking = msg.reasoning_content;
    for (const tc of msg.tool_calls ?? []) {
      let args = tc.function?.arguments ?? '{}';
      let parsed;
      try { parsed = JSON.parse(args || '{}'); } catch { parsed = { _raw: args }; }
      state.toolCalls.push({ id: tc.id ?? `call_${state.toolCalls.length}`, name: tc.function?.name ?? 'unknown', arguments: parsed });
    }
    if (json.usage) {
      state.usage = {
        input_tokens: json.usage.prompt_tokens ?? 0,
        output_tokens: json.usage.completion_tokens ?? 0,
      };
    }
    state.finish = FINISH_MAP[choice.finish_reason] ?? STOP.END;
  } else {
    const toolIndex = new Map();
    try {
      for await (const data of sseLines(response.body)) {
        if (data === '[DONE]') break;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.error) {
          throw new ProviderError(evt.error.message ?? 'provider stream error', { provider: 'openai', status: evt.error.code ?? undefined });
        }
        const choice = evt.choices?.[0];
        if (evt.usage) {
          state.usage = {
            input_tokens: evt.usage.prompt_tokens ?? 0,
            output_tokens: evt.usage.completion_tokens ?? 0,
          };
        }
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          state.thinking += delta.reasoning_content;
          onEvent?.({ type: 'thinking', delta: delta.reasoning_content });
        }
        if (typeof delta.reasoning === 'string' && delta.reasoning.length > 0) {
          state.thinking += delta.reasoning;
          onEvent?.({ type: 'thinking', delta: delta.reasoning });
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          state.text += delta.content;
          onEvent?.({ type: 'text', delta: delta.content });
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          if (!toolIndex.has(idx)) {
            toolIndex.set(idx, { id: '', name: '', arguments: '' });
          }
          const entry = toolIndex.get(idx);
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name += tc.function.name;
          if (typeof tc.function?.arguments === 'string') entry.arguments += tc.function.arguments;
        }
        if (choice.finish_reason) {
          state.finish = FINISH_MAP[choice.finish_reason] ?? STOP.END;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        state.finish = STOP.ABORTED;
      } else {
        throw err;
      }
    }
    state.toolCalls = [...toolIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, e]) => {
      let parsed;
      try { parsed = JSON.parse(e.arguments || '{}'); } catch { parsed = { _raw: e.arguments }; }
      return { id: e.id || `call_${i}`, name: e.name, arguments: parsed };
    });
  }

  onEvent?.({ type: 'usage', usage: state.usage });
  onEvent?.({ type: 'stop', reason: state.finish });

  return {
    text: state.text,
    thinking: state.thinking || undefined,
    tool_calls: state.toolCalls,
    usage: state.usage,
    stop_reason: state.finish,
    raw_assistant: buildRawAssistant(state),
  };
}

function buildRawAssistant(state) {
  const msg = { role: 'assistant', content: state.text || null };
  if (state.toolCalls.length > 0) {
    msg.tool_calls = state.toolCalls.map((c) => ({
      id: c.id, type: 'function',
      function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
    }));
  }
  return msg;
}

export async function listModelsOpenAi({ apiKey, baseUrl }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new ProviderError(`HTTP ${response.status} listing models`, { provider: 'openai', status: response.status });
  }
  const json = await readJsonResponse(response);
  return (json.data ?? []).map((m) => m.id).sort();
}
