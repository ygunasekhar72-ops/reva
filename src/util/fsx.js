// Filesystem helpers. Atomic JSON writes, safe JSON read, path normalization.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try { await fsp.stat(p); return true; } catch { return false; }
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// Atomic write: temp file in same directory + rename, so a crash never leaves
// a half-written config/keystore behind. Temp names include a random suffix:
// concurrent writers in the same millisecond (parallel subagents) would
// otherwise collide and crash each other's rename.
export async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`);
  const body = JSON.stringify(data, null, 2);
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.rename(tmp, file);
  return file;
}

export async function appendLine(file, line) {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, line + '\n', 'utf8');
}

export async function readTextLines(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export function resolveSafe(base, ...segments) {
  const target = path.resolve(base, ...segments);
  const normalizedBase = path.resolve(base);
  if (target !== normalizedBase && !target.startsWith(normalizedBase + path.sep)) {
    const err = new Error(`path escapes workspace: ${target}`);
    err.code = 'EESCAPE';
    throw err;
  }
  return target;
}

export async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return -1; }
}

export { fs, fsp, path };
