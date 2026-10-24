// Session event log: JSONL persistence + live fan-out. Every visible thing
// the agent does (thinking, tool calls, results, compaction) is an event here
// — this is what makes the process visible in both TUI and PWA.
import fsp from 'node:fs/promises';
import { ensureDir, appendLine } from '../util/fsx.js';
import path from 'node:path';

export class EventLog {
  constructor(file) {
    this.file = file;
    this.events = [];
    this.subscribers = new Set();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
      }
    } catch { /* new session */ }
    this.loaded = true;
    return this;
  }

  async append(event) {
    const entry = { seq: this.events.length, ts: Date.now(), ...event };
    this.events.push(entry);
    // Subscribers are notified synchronously BEFORE any await: concurrent
    // appends (streaming deltas) must reach consumers in event order. The
    // JSONL write below may interleave on disk under concurrency; `seq`
    // disambiguates.
    for (const sub of this.subscribers) {
      try { sub(entry); } catch { /* subscriber errors isolated */ }
    }
    if (this.file) {
      try {
        await ensureDir(path.dirname(this.file));
        await appendLine(this.file, JSON.stringify(entry));
      } catch { /* disk issues must not kill the agent */ }
    }
    return entry;
  }

  subscribe(fn, { replay = false } = {}) {
    if (replay) {
      for (const e of this.events) {
        try { fn(e); } catch { /* isolated */ }
      }
    }
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  since(seq) {
    return this.events.slice(seq + 1);
  }

  all() {
    return [...this.events];
  }
}

// Session metadata store: index of all sessions in a project.
export class SessionIndex {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, sessions: {} };
  }

  async load() {
    const { readJson } = await import('../util/fsx.js');
    this.data = await readJson(this.file, this.data);
    return this;
  }

  async _persist() {
    const { writeJsonAtomic } = await import('../util/fsx.js');
    await writeJsonAtomic(this.file, this.data);
  }

  async upsert(meta) {
    this.data.sessions[meta.id] = { ...this.data.sessions[meta.id], ...meta };
    await this._persist();
    return this.data.sessions[meta.id];
  }

  list({ limit = 50 } = {}) {
    return Object.values(this.data.sessions)
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, limit);
  }

  get(id) {
    return this.data.sessions[id] ?? null;
  }
}
