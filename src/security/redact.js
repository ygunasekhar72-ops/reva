// Secret redaction for logs and audit trail. Patterns match common key shapes
// and authorization headers. json() walks objects and masks designated fields.
const PATTERNS = [
  [/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***REDACTED***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh***_***REDACTED***'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA***REDACTED***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***REDACTED***'],
  [/x-api-key["':\s=]+[A-Za-z0-9._~+/=-]{8,}/gi, 'x-api-key: ***REDACTED***'],
  [/api[_-]?key["':\s=]+[A-Za-z0-9._~+/=-]{8,}/gi, 'api_key: ***REDACTED***'],
];

const SENSITIVE_FIELDS = new Set([
  'password', 'password_hash', 'token', 'api_key', 'apiKey', 'apikey',
  'secret', 'authorization', 'key_material', 'private_key', 'session_token',
]);

export function redact(text) {
  let out = String(text);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redactJson(value, depth = 0) {
  if (depth > 12) return '[depth-limit]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(k.toLowerCase()) && typeof v === 'string' && v.length > 0) {
      out[k] = '***REDACTED***';
    } else {
      out[k] = redactJson(v, depth + 1);
    }
  }
  return out;
}

// True if a string looks like a live credential (used by startup doctor).
export function looksLikeSecret(s) {
  return PATTERNS.some(([re]) => { re.lastIndex = 0; return re.test(String(s)); });
}
