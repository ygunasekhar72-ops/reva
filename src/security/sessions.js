// Bearer session tokens. Raw tokens are shown once and never stored — the
// store keeps only SHA-256 digests, so stealing accounts.json cannot mint a
// valid session. Sliding expiry, per-user revocation, max session cap.
import { createHash } from 'node:crypto';
import { randomToken } from '../util/ids.js';
import { readJson, writeJsonAtomic, exists } from '../util/fsx.js';

const MAX_SESSIONS_PER_USER = 16;

export class SessionStore {
  constructor(file, { ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.data = { version: 1, sessions: {} };
  }

  async load() {
    if (await exists(this.file)) {
      this.data = await readJson(this.file, this.data);
    }
    this._sweep();
    return this;
  }

  async _persist() {
    await writeJsonAtomic(this.file, this.data);
  }

  _hash(token) {
    return createHash('sha256').update(token).digest('base64');
  }

  async create(username, { ttlMs, roles } = {}) {
    const token = randomToken(32);
    const now = Date.now();
    const id = randomToken(8);
    const session = {
      id,
      username,
      token_hash: this._hash(token),
      created_at: now,
      expires_at: now + (ttlMs ?? this.ttlMs),
    };
    this.data.sessions[id] = session;
    // cap sessions per user
    const mine = Object.values(this.data.sessions)
      .filter((s) => s.username === username)
      .sort((a, b) => a.created_at - b.created_at);
    while (mine.length > MAX_SESSIONS_PER_USER) {
      const oldest = mine.shift();
      delete this.data.sessions[oldest.id];
    }
    await this._persist();
    return {
      token,
      id,
      username,
      role: roles ?? 'user',
      expires_at: new Date(session.expires_at).toISOString(),
    };
  }

  // Returns the session record (no raw token) or null.
  verify(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) return null;
    const hash = this._hash(token);
    for (const s of Object.values(this.data.sessions)) {
      if (s.token_hash === hash) {
        if (Date.now() > s.expires_at) return null;
        // sliding renewal (not persisted on every hit; persisted on sweep)
        s.expires_at = Math.max(s.expires_at, Date.now() + this.ttlMs);
        return { id: s.id, username: s.username };
      }
    }
    return null;
  }

  async revoke(token) {
    const hash = this._hash(token);
    let found = false;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (s.token_hash === hash) {
        delete this.data.sessions[id];
        found = true;
      }
    }
    if (found) await this._persist();
    return found;
  }

  async revokeAllFor(username) {
    let n = 0;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (s.username === username) {
        delete this.data.sessions[id];
        n += 1;
      }
    }
    if (n > 0) await this._persist();
    return n;
  }

  async revokeSessionId(id) {
    if (this.data.sessions[id]) {
      delete this.data.sessions[id];
      await this._persist();
      return true;
    }
    return false;
  }

  _sweep() {
    const now = Date.now();
    let dirty = false;
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (now > s.expires_at) {
        delete this.data.sessions[id];
        dirty = true;
      }
    }
    if (dirty) {
      this._persist().catch(() => {});
    }
  }
}
