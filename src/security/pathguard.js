// Path guard: every file tool path must resolve inside the workspace root.
// Defeats: ../ traversal, absolute escapes, drive-letter escapes on Windows,
// null bytes, UNC paths, and symlinked escapes (via realpath resolution).
import path from 'node:path';
import fsp from 'node:fs/promises';

export class PathGuardError extends Error {
  constructor(message, input) {
    super(message);
    this.code = 'EPATHGUARD';
    this.input = input;
    this.status = 403;
  }
}

function assertCleanString(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new PathGuardError('path must be a non-empty string', p);
  }
  if (p.length > 4096) throw new PathGuardError('path too long', p);
  // eslint-disable-next-line no-control-regex
  if (/[\0\r\n]/.test(p)) throw new PathGuardError('control characters in path', p);
}

function isAbsoluteUnsafe(p) {
  // /abs, C:\abs, C:rel, \\server\share
  return path.isAbsolute(p) || /^[a-zA-Z]:/.test(p) || /^\\\\/.test(p);
}

// Resolve and validate. Returns the absolute real path that stays under root.
// Both the base and the target go through the same "deepest existing ancestor"
// realpath resolution, so comparisons can never mix real and non-real
// prefixes (Windows 8.3 short names, symlinked homes, missing leaf dirs).
export async function guardPath(root, input, { allowMissing = true } = {}) {
  assertCleanString(input);
  if (isAbsoluteUnsafe(input)) {
    throw new PathGuardError('absolute paths are not allowed; use workspace-relative paths', input);
  }
  if (input.split(/[\\/]/).includes('..')) {
    throw new PathGuardError('path traversal is not allowed', input);
  }
  // Defense-in-depth: any segment made only of dots (besides '.') is refused —
  // '....', '.. .'-style payloads exploit naive normalizers elsewhere.
  for (const seg of input.split(/[\\/]/)) {
    if (/^\.{2,}$/.test(seg)) {
      throw new PathGuardError('suspicious dot-segment in path', input);
    }
  }
  const rootReal = await realpathOfDeepestExisting(path.resolve(root));
  const joined = path.resolve(rootReal, input);
  if (joined !== rootReal && !joined.startsWith(rootReal + path.sep)) {
    throw new PathGuardError('resolved path escapes the workspace', input);
  }
  // Symlink check: resolve what exists of the chain and re-validate.
  let real;
  try {
    real = await fsp.realpath(joined);
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (!allowMissing) throw new PathGuardError('path does not exist', input);
      // validate the deepest existing ancestor instead
      real = await realpathOfDeepestExisting(joined);
    } else {
      throw new PathGuardError(`path could not be resolved: ${err.code}`, input);
    }
  }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
    throw new PathGuardError('symlink escapes the workspace', input);
  }
  return real;
}

async function realpathOrSelf(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

async function realpathOfDeepestExisting(p) {
  let cur = p;
  const stack = [];
  while (true) {
    try {
      const real = await fsp.realpath(cur);
      let rebuilt = real;
      for (const seg of stack.reverse()) rebuilt = path.join(rebuilt, seg);
      return rebuilt;
    } catch (err) {
      if (err.code === 'ENOENT') {
        const parent = path.dirname(cur);
        if (parent === cur) return p;
        stack.push(path.basename(cur));
        cur = parent;
      } else {
        return p;
      }
    }
  }
}

// Validate a workspace-relative display path returned to models/UI.
// Async because the base is realpath-resolved (same rules as guardPath).
export async function toRelative(root, abs) {
  const rootReal = await realpathOfDeepestExisting(path.resolve(root));
  const rel = path.relative(rootReal, abs);
  return rel.split(path.sep).join('/');
}
