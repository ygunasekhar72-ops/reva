// Provider-agnostic errors and normalized event shapes.
export class ProviderError extends Error {
  constructor(message, { status, provider, code, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.provider = provider;
    this.status = status;
    this.code = code ?? (status === 401 || status === 403 ? 'auth' : 'provider');
    this.retryable = retryable ?? (status === 429 || (status >= 500 && status <= 599));
  }
}

export class ProviderAuthError extends ProviderError {
  constructor(provider, detail) {
    super(`missing API key for provider "${provider}"${detail ? `: ${detail}` : ''}`, {
      provider, status: 401, code: 'auth',
    });
    this.name = 'ProviderAuthError';
  }
}

// Events emitted by every provider (normalized):
//  {type:'thinking', delta}  — reasoning tokens, when the model provides them
//  {type:'text', delta}      — assistant text deltas
//  {type:'tool_call', call}  — complete normalized tool call {id,name,arguments}
//  {type:'usage', usage}     — {input_tokens, output_tokens}
//  {type:'stop', reason}     — final stop reason (normalized)
export const STOP = {
  END: 'end_turn',
  TOOL: 'tool_use',
  LENGTH: 'max_tokens',
  ABORTED: 'aborted',
  ERROR: 'error',
};
