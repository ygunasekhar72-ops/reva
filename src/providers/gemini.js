// Google Gemini provider: streamGenerateContent with alt=sse, function
// calling, and thought summaries when the model exposes them.
import { ProviderError, STOP } from './types.js';
import { sseLines, readJsonResponse } from './sse.js';

const SCHEMA_ALLOWED = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'minimum', 'maximum']);

function cleanSchema(schema) {
  if (schema === null || typeof schema !== 'object') return undefined;
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_ALLOWED.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, cleanSchema(pv)]));
    } else {
      out[k] = cleanSchema(v);
    }
  }
  if (typeof schema.type === 'string') out.type = schema.type.toUpperCase();
  return out;
}

export function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: cleanSchema(t.parameters ?? { type: 'object', properties: {} }) ?? { type: 'OBJECT' },
    })),
  }];
}

export function fromInternalMessages(messages) {
  const systemParts = [];
  const contents = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) systemParts.push({ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.name ?? m.tool_call_id ?? 'tool',
            response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '') },
          },
        }],
      });
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    if (typeof m.content === 'string' && m.content.length > 0) parts.push({ text: m.content });
    for (const c of m.tool_calls ?? []) {
      parts.push({ functionCall: { name: c.name, args: typeof c.arguments === 'string' ? safeParse(c.arguments) : (c.arguments ?? {}) } });
    }
    if (parts.length === 0) parts.push({ text: '' });
    contents.push({ role, parts });
  }
  return { systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined, contents };
}

const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

const STOP_MAP = { STOP: STOP.END, MAX_TOKENS: STOP.LENGTH, SAFETY: STOP.END, RECITATION: STOP.END };

export async function chatGemini({ apiKey, baseUrl, model, messages, tools, temperature, signal, onEvent, maxTokens, extraHeaders }) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const { systemInstruction, contents } = fromInternalMessages(messages);
  const body = { contents, generationConfig: {} };
  if (typeof temperature === 'number') body.generationConfig.temperature = temperature;
  if (maxTokens) body.generationConfig.maxOutputTokens = maxTokens;
  const gemTools = toGeminiTools(tools);
  if (gemTools) body.tools = gemTools;
  if (systemInstruction) body.systemInstruction = systemInstruction;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey, ...(extraHeaders ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`network error: ${err.message}`, { provider: 'gemini', retryable: true });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError(`HTTP ${response.status}: ${detail.slice(0, 500)}`, {
      provider: 'gemini', status: response.status,
    });
  }

  const state = { text: '', thinking: '', toolCalls: [], usage: { input_tokens: 0, output_tokens: 0 }, finish: STOP.END };
  let callCounter = 0;

  const consumeChunk = (chunk) => {
    if (chunk.usageMetadata) {
      state.usage.input_tokens = chunk.usageMetadata.promptTokenCount ?? state.usage.input_tokens;
      state.usage.output_tokens = chunk.usageMetadata.candidatesTokenCount ?? state.usage.output_tokens;
      if (chunk.usageMetadata.thoughtsTokenCount) {
        state.usage.thinking_tokens = chunk.usageMetadata.thoughtsTokenCount;
      }
    }
    const cand = chunk.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) state.finish = STOP_MAP[cand.finishReason] ?? STOP.END;
    for (const part of cand.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        if (part.thought === true) {
          state.thinking += part.text;
          onEvent?.({ type: 'thinking', delta: part.text });
        } else {
          state.text += part.text;
          onEvent?.({ type: 'text', delta: part.text });
        }
      }
      if (part.functionCall) {
        const call = {
          id: `gemini_call_${callCounter++}`,
          name: part.functionCall.name,
          arguments: part.functionCall.args ?? {},
        };
        state.toolCalls.push(call);
      }
    }
  };

  try {
    for await (const data of sseLines(response.body)) {
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.error) {
        throw new ProviderError(chunk.error.message ?? 'gemini stream error', { provider: 'gemini' });
      }
      consumeChunk(chunk);
    }
  } catch (err) {
    if (err.name === 'AbortError') state.finish = STOP.ABORTED;
    else throw err;
  }

  onEvent?.({ type: 'usage', usage: state.usage });
  onEvent?.({ type: 'stop', reason: state.finish });

  return {
    text: state.text,
    thinking: state.thinking || undefined,
    tool_calls: state.toolCalls,
    usage: state.usage,
    stop_reason: state.finish,
    raw_assistant: null,
  };
}

export async function listModelsGemini({ apiKey, baseUrl }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1beta/models`, {
    headers: { 'x-goog-api-key': apiKey },
  });
  if (!response.ok) {
    throw new ProviderError(`HTTP ${response.status} listing models`, { provider: 'gemini', status: response.status });
  }
  const json = await readJsonResponse(response);
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map((m) => String(m.name).replace(/^models\//, ''))
    .sort();
}
