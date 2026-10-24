// Anthropic Messages API provider: SSE streaming, tool_use blocks, and
// extended-thinking blocks (preserved across tool loops as the API requires).
import { ProviderError, STOP } from './types.js';
import { sseLines, readJsonResponse } from './sse.js';

const ANTHROPIC_VERSION = '2023-06-01';

export function toAnthropicTools(tools) {
  return (tools ?? []).map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }));
}

// Internal -> Anthropic. System messages go to the top-level `system` param;
// tool results become user tool_result blocks; assistant messages keep
// tool_use + thinking blocks (stored by the agent as provider_raw).
export function fromInternalMessages(messages) {
  const system = [];
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) system.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
        }],
      });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      const raw = m.provider_raw;
      for (const b of raw?.content ?? []) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') blocks.push(b);
        if (b.type === 'tool_use') blocks.push(b);
      }
      if (typeof m.content === 'string' && m.content.length > 0) {
        // text was already present in raw content; avoid duplication
        if (!blocks.some((b) => b.type === 'text' && b.text === m.content)) {
          blocks.push({ type: 'text', text: m.content });
        }
      }
      if (Array.isArray(m.tool_calls) && !raw) {
        for (const c of m.tool_calls) {
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: typeof c.arguments === 'string' ? safeParse(c.arguments) : (c.arguments ?? {}),
          });
        }
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: m.content ?? '' }] });
      continue;
    }
    out.push({ role: 'user', content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') }] });
  }
  // Anthropic requires alternating roles starting with user; merge same-role
  // neighbours (common when several tool results arrive back-to-back).
  const merged = [];
  for (const msg of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...toArray(prev.content), ...toArray(msg.content)];
    } else {
      merged.push(msg);
    }
  }
  return { system: system.length > 0 ? system.join('\n\n') : undefined, messages: merged };
}

const toArray = (c) => (Array.isArray(c) ? c : [c]);
const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const STOP_MAP = {
  end_turn: STOP.END,
  stop_sequence: STOP.END,
  max_tokens: STOP.LENGTH,
  tool_use: STOP.TOOL,
};

export async function chatAnthropic({ apiKey, baseUrl, model, messages, tools, temperature, signal, onEvent, maxTokens, thinkingBudget, extraHeaders }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const { system, messages: converted } = fromInternalMessages(messages);
  const body = {
    model,
    max_tokens: maxTokens ?? 8192,
    messages: converted,
    stream: true,
  };
  if (system) body.system = system;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (tools && tools.length > 0) body.tools = toAnthropicTools(tools);
  if (thinkingBudget && thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: Math.min(thinkingBudget, (body.max_tokens ?? 8192) - 1) };
  }

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        ...(extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`network error: ${err.message}`, { provider: 'anthropic', retryable: true });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(`HTTP ${response.status}: ${detail.slice(0, 500)}`, {
      provider: 'anthropic', status: response.status,
    });
  }

  const state = { text: '', thinking: '', toolCalls: [], blocks: [], usage: { input_tokens: 0, output_tokens: 0 }, finish: STOP.END };
  let currentBlock = null;

  const flushBlock = () => {
    if (!currentBlock) return;
    if (currentBlock.type === 'text') {
      state.blocks.push({ type: 'text', text: currentBlock.text });
    } else if (currentBlock.type === 'thinking') {
      state.blocks.push({ type: 'thinking', thinking: currentBlock.text, signature: currentBlock.signature });
    } else if (currentBlock.type === 'tool_use') {
      let input;
      try { input = JSON.parse(currentBlock.json || '{}'); } catch { input = {}; }
      const call = { id: currentBlock.id, name: currentBlock.name, arguments: input };
      state.toolCalls.push(call);
      state.blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    currentBlock = null;
  };

  try {
    for await (const data of sseLines(response.body)) {
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      switch (evt.type) {
        case 'message_start':
          state.usage.input_tokens = evt.message?.usage?.input_tokens ?? 0;
          break;
        case 'content_block_start': {
          flushBlock();
          const b = evt.content_block ?? {};
          if (b.type === 'text') currentBlock = { type: 'text', text: '' };
          else if (b.type === 'thinking') currentBlock = { type: 'thinking', text: '', signature: '' };
          else if (b.type === 'redacted_thinking') {
            flushBlock();
            state.blocks.push({ type: 'redacted_thinking', data: b.data });
          } else if (b.type === 'tool_use') {
            currentBlock = { type: 'tool_use', id: b.id, name: b.name, json: '' };
          }
          break;
        }
        case 'content_block_delta': {
          const d = evt.delta ?? {};
          if (d.type === 'text_delta' && currentBlock?.type === 'text') {
            currentBlock.text += d.text;
            state.text += d.text;
            onEvent?.({ type: 'text', delta: d.text });
          } else if (d.type === 'thinking_delta' && currentBlock?.type === 'thinking') {
            currentBlock.text += d.thinking;
            state.thinking += d.thinking;
            onEvent?.({ type: 'thinking', delta: d.thinking });
          } else if (d.type === 'signature_delta' && currentBlock?.type === 'thinking') {
            currentBlock.signature += d.signature ?? '';
          } else if (d.type === 'input_json_delta' && currentBlock?.type === 'tool_use') {
            currentBlock.json += d.partial_json ?? '';
          }
          break;
        }
        case 'content_block_stop':
          flushBlock();
          break;
        case 'message_delta':
          if (evt.usage?.output_tokens) state.usage.output_tokens = evt.usage.output_tokens;
          if (evt.delta?.stop_reason) state.finish = STOP_MAP[evt.delta.stop_reason] ?? STOP.END;
          break;
        case 'message_stop':
          break;
        case 'error':
          throw new ProviderError(evt.error?.message ?? 'anthropic stream error', { provider: 'anthropic' });
        case 'ping':
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      state.finish = STOP.ABORTED;
    } else {
      throw err;
    }
  }
  flushBlock();

  onEvent?.({ type: 'usage', usage: state.usage });
  onEvent?.({ type: 'stop', reason: state.finish });

  const rawBlocks = state.blocks.map((b) => (b.type === 'thinking' && !b.signature ? { ...b, signature: b.signature ?? '' } : b));
  return {
    text: state.text,
    thinking: state.thinking || undefined,
    tool_calls: state.toolCalls,
    usage: state.usage,
    stop_reason: state.finish,
    raw_assistant: { role: 'assistant', content: rawBlocks },
  };
}

export async function listModelsAnthropic({ apiKey, baseUrl }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, {
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
  });
  if (!response.ok) {
    throw new ProviderError(`HTTP ${response.status} listing models`, { provider: 'anthropic', status: response.status });
  }
  const json = await readJsonResponse(response);
  return (json.data ?? []).map((m) => m.id).sort();
}
