// Password hashing (scrypt), authenticated encryption (AES-256-GCM), and the
// encrypted keystore for provider API keys.
//
// Threat model: keys at rest must be useless to an attacker who steals the
// files but does not know the master password. Hashes use per-user random
// salts; ciphertext carries its own IV and GCM auth tag; version fields allow
// future parameter upgrades.
import crypto from 'node:crypto';
import { writeJsonAtomic, readJson } from '../util/fsx.js';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };
const KDF_SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 32, maxmem: 128 * 1024 * 1024 };

export const VERSION = 1;

export function hashPassword(password) {
  assertPassword(password);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT);
  return {
    version: VERSION,
    algo: 'scrypt',
    params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
  };
}

export function verifyPassword(password, record) {
  if (!record || record.algo !== 'scrypt' || typeof record.hash !== 'string') return false;
  try {
    assertPassword(password);
  } catch {
    return false; // invalid input is a failed verify, not a crash
  }
  const salt = Buffer.from(record.salt, 'base64');
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
    N: record.params?.N ?? SCRYPT.N,
    r: record.params?.r ?? SCRYPT.r,
    p: record.params?.p ?? SCRYPT.p,
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function assertPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) {
    const err = new Error('password must be a string of at least 8 characters');
    err.status = 400;
    err.code = 'weak_password';
    throw err;
  }
  if (pw.length > 1024) {
    const err = new Error('password too long');
    err.status = 400;
    err.code = 'weak_password';
    throw err;
  }
}

// ---- AES-256-GCM envelope -----------------------------------------------

function deriveKey(password, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  return crypto.scryptSync(password.normalize('NFKC'), salt, KDF_SCRYPT.keylen, KDF_SCRYPT);
}

export function encryptBlob(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt.toString('base64'));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    version: VERSION,
    algo: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ct.toString('base64'),
  };
}

export function decryptBlob(blob, password) {
  if (!blob || blob.algo !== 'aes-256-gcm') throw new Error('unsupported blob');
  const key = deriveKey(password, blob.salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'base64')),
    decipher.final(), // throws on tamper
  ]);
  return pt.toString('utf8');
}

// ---- Keystore -------------------------------------------------------------

// Maps provider key names to secret values, sealed under the master password.
export class Keystore {
  constructor(file) {
    this.file = file;
    this.data = { version: VERSION, entries: {} };
    this.unlocked = false;
  }

  async loadSealed() {
    const onDisk = await readJson(this.file, null);
    if (onDisk) this.data = onDisk;
    return this.sealed();
  }

  sealed() {
    return {
      exists: Object.keys(this.data.entries || {}).length > 0,
      names: Object.keys(this.data.entries || {}),
      unlocked: this.unlocked,
    };
  }

  async create(password) {
    if (Object.keys(this.data.entries || {}).length > 0) {
      throw new Error('keystore already exists');
    }
    this.master = password;
    this.unlocked = true;
    await this._persist();
  }

  async unlock(password) {
    // GCM auth tag proves the password; wrong password throws.
    const names = Object.keys(this.data.entries || {});
    if (names.length === 0) {
      // empty keystore: any password unlocks it (nothing to prove yet)
      this.master = password;
      this.unlocked = true;
      return true;
    }
    // verify by decrypting every entry (cheap; few entries)
    for (const name of names) {
      decryptBlob(this.data.entries[name], password); // throws if wrong
    }
    this.master = password;
    this.unlocked = true;
    return true;
  }

  lock() {
    this.master = undefined;
    this.unlocked = false;
  }

  assertUnlocked() {
    if (!this.unlocked) throw new Error('keystore is locked');
  }

  async setSecret(name, value) {
    this.assertUnlocked();
    // names may be namespaced like "provider:openai" or "search:brave"
    if (!/^[a-z0-9:_.-]{1,64}$/i.test(name)) throw new Error('invalid secret name');
    this.data.entries[name] = encryptBlob(String(value), this.master);
    await this._persist();
  }

  getSecret(name) {
    this.assertUnlocked();
    const blob = this.data.entries[name];
    if (!blob) return undefined;
    return decryptBlob(blob, this.master);
  }

  async removeSecret(name) {
    this.assertUnlocked();
    delete this.data.entries[name];
    await this._persist();
  }

  listNames() {
    return Object.keys(this.data.entries || {});
  }

  async changeMaster(oldPassword, newPassword) {
    const names = this.listNames();
    await this.unlock(oldPassword);
    const secrets = Object.fromEntries(names.map((n) => [n, this.getSecret(n)]));
    this.master = newPassword;
    this.data.entries = {};
    for (const [n, v] of Object.entries(secrets)) {
      this.data.entries[n] = encryptBlob(v, newPassword);
    }
    await this._persist();
  }

  async _persist() {
    await writeJsonAtomic(this.file, this.data);
  }
}

export function randomSalt() {
  return crypto.randomBytes(16).toString('base64');
}
