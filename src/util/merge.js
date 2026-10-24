// Deep merge that is prototype-pollution safe: __proto__, constructor.prototype
// and any key containing those tokens are refused, not silently merged.
export function deepMerge(base, patch) {
  return mergeInto(structuredCloneSafe(base), patch, []);
}

function mergeInto(target, patch, stack) {
  if (patch === null || patch === undefined) return target;
  if (typeof patch !== 'object' || Array.isArray(patch)) return structuredCloneSafe(patch);
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    target = {};
  }
  for (const key of Object.keys(patch)) {
    if (isForbiddenKey(key)) {
      const err = new Error(`forbidden key in merge: ${key}`);
      err.code = 'EPOLLUTION';
      throw err;
    }
    const val = patch[key];
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      if (stack.length > 32) throw new Error('merge depth exceeded');
      target[key] = mergeInto(target[key], val, [...stack, key]);
    } else {
      target[key] = structuredCloneSafe(val);
    }
  }
  return target;
}

function isForbiddenKey(key) {
  const k = String(key);
  return k === '__proto__' || k === 'constructor' || k === 'prototype'
    || k.includes('__proto__') || k.includes('constructor.prototype');
}

// structuredClone with JSON-only semantics: drops functions, undefined and
// class instances, which is exactly what we want for config/data.
export function structuredCloneSafe(value) {
  if (value === undefined || typeof value === 'function') return null;
  try {
    return structuredClone(JSON.parse(JSON.stringify(value)));
  } catch {
    return JSON.parse(JSON.stringify(value ?? null));
  }
}
