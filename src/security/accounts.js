// User accounts: local credential store with scrypt hashes and brute-force
// lockout. The first registered account becomes the admin.
import { hashPassword, verifyPassword } from './crypto.js';
import { readJson, writeJsonAtomic, exists } from '../util/fsx.js';
import { timingSafeEqual } from 'node:crypto';

const NAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export class AccountStore {
  constructor(file, { maxAttempts = 5, lockoutMs = 15 * 60 * 1000 } = {}) {
    this.file = file;
    this.maxAttempts = maxAttempts;
    this.lockoutMs = lockoutMs;
    this.data = { version: 1, accounts: {} };
  }

  async load() {
    if (await exists(this.file)) {
      this.data = await readJson(this.file, this.data);
    }
    return this;
  }

  async _persist() {
    await writeJsonAtomic(this.file, this.data);
  }

  get count() {
    return Object.keys(this.data.accounts).length;
  }

  list() {
    return Object.values(this.data.accounts).map((a) => ({
      username: a.username,
      role: a.role,
      created_at: a.created_at,
    }));
  }

  isValidName(name) {
    return typeof name === 'string' && NAME_RE.test(name);
  }

  async register(username, password, { role } = {}) {
    if (!this.isValidName(username)) {
      throw new AuthError('invalid username (3-32 chars, letters/digits/_.-)', 'invalid_username', 400);
    }
    if (this.data.accounts[username]) {
      throw new AuthError('username already taken', 'username_taken', 409);
    }
    const hash = hashPassword(password); // throws if weak
    const account = {
      username,
      role: role ?? (this.count === 0 ? 'admin' : 'user'),
      created_at: new Date().toISOString(),
      password: hash,
      failed_attempts: 0,
      locked_until: 0,
    };
    this.data.accounts[username] = account;
    await this._persist();
    return this.publicView(account);
  }

  // Returns { username, role } or throws AuthError. Enforces lockout and
  // resets failure counter on success.
  async login(username, password) {
    const account = this.data.accounts[username];
    if (!account) {
      // burn equivalent time so user enumeration via timing is harder
      hashPassword(password || 'x'.repeat(12));
      throw new AuthError('invalid credentials', 'invalid_credentials');
    }
    const now = Date.now();
    if (account.locked_until > now) {
      const secs = Math.ceil((account.locked_until - now) / 1000);
      throw new AuthError(`account locked, try again in ${secs}s`, 'locked');
    }
    let ok = false;
    try {
      ok = verifyPassword(password, account.password);
    } catch {
      ok = false;
    }
    if (!ok) {
      account.failed_attempts += 1;
      if (account.failed_attempts >= this.maxAttempts) {
        account.locked_until = now + this.lockoutMs;
        account.failed_attempts = 0;
        await this._persist();
        const secs = Math.ceil(this.lockoutMs / 1000);
        throw new AuthError(`account locked, try again in ${secs}s`, 'locked');
      }
      await this._persist();
      throw new AuthError('invalid credentials', 'invalid_credentials');
    }
    account.failed_attempts = 0;
    account.locked_until = 0;
    await this._persist();
    return this.publicView(account);
  }

  async changePassword(username, oldPassword, newPassword) {
    const account = this.data.accounts[username];
    if (!account) throw new AuthError('no such user', 'no_user');
    if (!verifyPassword(oldPassword, account.password)) {
      throw new AuthError('invalid credentials', 'invalid_credentials');
    }
    account.password = hashPassword(newPassword);
    await this._persist();
    return true;
  }

  get(username) {
    return this.data.accounts[username] ?? null;
  }

  publicView(account) {
    return { username: account.username, role: account.role };
  }

  verifyPasswordValue(username, password) {
    const account = this.data.accounts[username];
    if (!account) return false;
    try {
      return verifyPassword(password, account.password);
    } catch {
      return false;
    }
  }

  constantTimeEquals(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}

export class AuthError extends Error {
  constructor(message, code, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
