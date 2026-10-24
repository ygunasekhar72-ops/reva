// Tamper-evident audit log: JSONL with hash chaining. Each entry includes the
// sha256 of the previous entry, so silent edits/reorders are detectable.
import { createHash } from 'node:crypto';
import { appendLine, readTextLines } from '../util/fsx.js';
import { redactJson } from './redact.js';

export const AUDIT_EVENTS = {
  LOGIN_OK: 'auth.login.ok',
  LOGIN_FAIL: 'auth.login.fail',
  LOGIN_LOCKED: 'auth.login.locked',
  LOGOUT: 'auth.logout',
  REGISTER: 'auth.register',
  KEY_SET: 'keys.set',
  KEY_REMOVE: 'keys.remove',
  SESSION_CREATE: 'session.create',
  TOOL_CALL: 'tool.call',
  TOOL_DANGEROUS: 'tool.dangerous',
  TOOL_BLOCKED: 'tool.blocked',
  WEB_FETCH: 'web.fetch',
  MCP_CALL: 'mcp.call',
  BOT_RUN: 'bot.run',
  CONFIG_CHANGE: 'config.change',
  COMPACT: 'memory.compact',
};

export class AuditLog {
  constructor(file) {
    this.file = file;
    this._lastHash = null;
  }

  async load() {
    const lines = await readTextLines(this.file);
    if (lines.length > 0) {
      try {
        this._lastHash = JSON.parse(lines[lines.length - 1]).entry_hash;
      } catch {
        this._lastHash = null;
      }
    }
    return this;
  }

  async record(actor, event, detail = {}) {
    const ts = Date.now();
    const entry = {
      seq: (this._seq ?? 0) + 1,
      ts: new Date(ts).toISOString(),
      actor,
      event,
      detail: redactJson(detail),
      prev_hash: this._lastHash ?? 'GENESIS',
    };
    entry.entry_hash = createHash('sha256')
      .update(JSON.stringify({ seq: entry.seq, ts: entry.ts, actor: entry.actor, event: entry.event, detail: entry.detail, prev_hash: entry.prev_hash }))
      .digest('hex');
    this._seq = entry.seq;
    this._lastHash = entry.entry_hash;
    await appendLine(this.file, JSON.stringify(entry));
    return entry;
  }

  // Verify chain integrity; returns { ok, brokenAt, entries }.
  async verify() {
    const lines = await readTextLines(this.file);
    let prevHash = 'GENESIS';
    let brokenAt = null;
    const entries = [];
    for (let i = 0; i < lines.length; i++) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        brokenAt = i;
        break;
      }
      const expected = createHash('sha256')
        .update(JSON.stringify({ seq: entry.seq, ts: entry.ts, actor: entry.actor, event: entry.event, detail: entry.detail, prev_hash: entry.prev_hash }))
        .digest('hex');
      if (entry.prev_hash !== prevHash || entry.entry_hash !== expected) {
        brokenAt = i;
        break;
      }
      prevHash = entry.entry_hash;
      entries.push(entry);
    }
    return { ok: brokenAt === null, brokenAt, entries, total: lines.length };
  }
}
