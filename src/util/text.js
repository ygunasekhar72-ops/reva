// Text utilities: token estimation, truncation, ANSI handling, frontmatter.

// Cheap, dependency-free token estimate (~4 chars/token). Used for compaction
// thresholds; not meant to replace a real tokenizer.
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

export function estimateMessagesTokens(messages) {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content);
    if (Array.isArray(m.tool_calls)) total += estimateTokens(JSON.stringify(m.tool_calls));
  }
  return total;
}

export function truncate(text, max = 400, suffix = '…') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s) => String(s ?? '').replace(ANSI_RE, '');

export function visibleWidth(s) {
  return stripAnsi(s).length;
}

// Parse `---\nkey: value\n---\nbody` YAML-lite frontmatter (flat keys, arrays
// via comma or dash lists). Only what skills need; no eval, no dependency.
export function parseFrontmatter(text) {
  const src = String(text ?? '');
  if (!src.startsWith('---')) return { data: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };
  const head = src.slice(3, end).replace(/^\r?\n/, '');
  const body = src.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  let currentKey = null;
  for (const rawLine of head.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (/^\s+-\s+/.test(rawLine) && currentKey) {
      const val = rawLine.trim().slice(1).trim();
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(scalar(val));
      continue;
    }
    const idx = rawLine.indexOf(':');
    if (idx === -1) continue;
    const key = rawLine.slice(0, idx).trim();
    const rest = rawLine.slice(idx + 1).trim();
    currentKey = key;
    if (rest === '') { data[key] = rest; continue; }
    data[key] = scalar(rest);
  }
  return { data, body };
}

function scalar(v) {
  const s = String(v).trim().replace(/^["']|["']$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

// Split text into comma list, respecting quotes.
export function splitList(s) {
  const out = [];
  let cur = '', q = null;
  for (const ch of String(s)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function isValidUrl(s) {
  try {
    const u = new URL(String(s));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}
