// Provider registry: resolves provider config + API key (keystore first, then
// environment), dispatches by kind, retries retryable failures with backoff.
import { chatOpenAi, listModelsOpenAi } from './openai.js';
import { chatAnthropic, listModelsAnthropic } from './anthropic.js';
import { chatGemini, listModelsGemini } from './gemini.js';
import { ProviderError, ProviderAuthError } from './types.js';

export const KIND_DISPATCH = {
  openai: { chat: chatOpenAi, listModels: listModelsOpenAi },
  anthropic: { chat: chatAnthropic, listModels: listModelsAnthropic },
  gemini: { chat: chatGemini, listModels: listModelsGemini },
};

export const PROVIDER_CATALOG = [
  { key: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o4-mini'], kind: 'openai' },
  { key: 'anthropic', label: 'Anthropic', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'], kind: 'anthropic' },
  { key: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'], kind: 'gemini' },
  { key: 'grok', label: 'xAI Grok', models: ['grok-4', 'grok-3-mini', 'grok-3'], kind: 'openai' },
  { key: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], kind: 'openai' },
  { key: 'openrouter', label: 'OpenRouter', models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4.5'], kind: 'openai' },
];

export class ProviderRegistry {
  constructor({ config, keystore, env = process.env } = {}) {
    this.config = config;
    this.keystore = keystore;
    this.env = env;
  }

  providerNames() {
    return Object.keys(this.config.get('providers') ?? {});
  }

  getProviderConfig(name) {
    const providers = this.config.get('providers') ?? {};
    const pcfg = providers[name];
    if (!pcfg) throw new ProviderError(`unknown provider: ${name}`, { provider: name, status: 400 });
    return pcfg;
  }

  // Key precedence: keystore ("provider:<name>") -> env var -> explicit.
  resolveApiKey(name, pcfg) {
    if (this.keystore?.unlocked) {
      const secret = this.keystore.getSecret(`provider:${name}`);
      if (secret) return secret;
    }
    if (pcfg.api_key && typeof pcfg.api_key === 'string' && pcfg.api_key.length > 0) {
      return pcfg.api_key;
    }
    const envName = pcfg.api_key_env;
    if (envName && this.env[envName]) return this.env[envName];
    throw new ProviderAuthError(name, `set it via 'reva auth key ${name}' or $${envName ?? 'PROVIDER_API_KEY'}`);
  }

  resolve(name) {
    const pcfg = this.getProviderConfig(name);
    const kind = KIND_DISPATCH[pcfg.kind];
    if (!kind) throw new ProviderError(`provider "${name}" has unknown kind "${pcfg.kind}"`, { provider: name });
    return {
      name,
      kind: pcfg.kind,
      baseUrl: pcfg.base_url,
      model: pcfg.model,
      apiKey: this.resolveApiKey(name, pcfg),
      dispatch: kind,
      options: pcfg.options ?? {},
    };
  }

  isConfigured(name) {
    try {
      this.resolve(name);
      return true;
    } catch {
      return false;
    }
  }

  // Chat with retry. onEvent receives normalized stream events.
  async chat(providerName, {
    messages, tools, model, temperature, signal, onEvent,
    maxTokens, thinkingBudget, maxRetries = 3, extraHeaders,
  }) {
    const resolved = this.resolve(providerName);
    const useModel = model ?? resolved.model;
    if (!useModel) {
      throw new ProviderError(`no model specified for provider "${providerName}"`, { provider: providerName, status: 400 });
    }
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await resolved.dispatch.chat({
          apiKey: resolved.apiKey,
          baseUrl: resolved.baseUrl,
          model: useModel,
          messages,
          tools,
          temperature,
          signal,
          onEvent,
          maxTokens,
          thinkingBudget: thinkingBudget ?? resolved.options.thinking_budget,
          extraHeaders,
        });
      } catch (err) {
        lastError = err;
        if (err.name === 'AbortError') throw err;
        const retryable = err instanceof ProviderError ? err.retryable : false;
        if (!retryable || attempt === maxRetries) break;
        const retryAfter = Number(err.headers?.get?.('retry-after')) * 1000;
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter
          : Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        await sleep(delay, signal);
      }
    }
    throw lastError;
  }

  async listModels(providerName) {
    const resolved = this.resolve(providerName);
    return resolved.dispatch.listModels({ apiKey: resolved.apiKey, baseUrl: resolved.baseUrl });
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
