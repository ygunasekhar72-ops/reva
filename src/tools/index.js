// Tool registry. Tools are the only way the model touches the world, so every
// execution funnels through here: schema validation, plugin hooks, audit,
// timeout, and normalized errors the model can read.
import { randomBytes } from 'node:crypto';

export class ToolError extends Error {
  constructor(message, { status = 400, code = 'etool' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class ToolRegistry {
  constructor({ onEvent, audit } = {}) {
    this.tools = new Map();
    this.onEvent = onEvent;
    this.audit = audit;
    this.pluginEmit = null; // set by harness wiring
    this.execContextOverrides = new Map();
  }

  register(def) {
    assertToolDef(def);
    this.tools.set(def.name, def);
    return def;
  }

  registerAll(defs) {
    for (const d of defs) this.register(d);
  }

  unregister(name) {
    this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name) ?? null;
  }

  names() {
    return [...this.tools.keys()];
  }

  // Tool list for the model. Filter: mode 'all' | names | predicate.
  defsFor({ filter } = {}) {
    let defs = [...this.tools.values()];
    if (typeof filter === 'function') defs = defs.filter((d) => filter(d));
    if (Array.isArray(filter)) defs = defs.filter((d) => filter.includes(d.name));
    return defs.map((d) => ({
      name: d.name,
      description: d.description,
      parameters: d.parameters,
    }));
  }

  setPluginEmit(fn) {
    this.pluginEmit = fn;
  }

  // ctx: { workspace, session, emit(event), signal, confirmed, mode }
  async execute(name, args, ctx) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolError(`unknown tool: ${name}`, { code: 'enotool', status: 404 });
    }
    const callId = `tool_${randomBytes(6).toString('hex')}`;
    const started = Date.now();

    let validation = validateArgs(tool.parameters, args ?? {});
    if (!validation.ok) {
      throw new ToolError(`invalid arguments for ${name}: ${validation.errors.join('; ')}`, { code: 'eargs' });
    }

    // Plugin pre-hook can veto (throw) or observe.
    if (this.pluginEmit) {
      await this.pluginEmit('tool:before', { tool: name, args: args ?? {} });
    }

    const event = {
      type: 'tool_start',
      call_id: callId,
      tool: name,
      args: args ?? {},
      ts: started,
    };
    ctx?.emit?.(event);

    try {
      const result = await tool.execute(args ?? {}, ctx);
      const elapsed = Date.now() - started;
      const out = normalizeResult(result);
      ctx?.emit?.({ type: 'tool_result', call_id: callId, tool: name, ok: true, elapsed_ms: elapsed, result: out });
      if (this.audit && (tool.dangerous || name === 'exec')) {
        await this.audit.record(ctx?.session?.actor ?? 'agent', name === 'exec' ? 'tool.call' : 'tool.dangerous', { tool: name, args: args ?? {} });
      }
      if (this.pluginEmit) {
        await this.pluginEmit('tool:after', { tool: name, ok: true, elapsed_ms: elapsed });
      }
      return out;
    } catch (err) {
      const elapsed = Date.now() - started;
      const message = err instanceof ToolError ? err.message : (err.message ?? String(err));
      ctx?.emit?.({ type: 'tool_result', call_id: callId, tool: name, ok: false, elapsed_ms: elapsed, error: message });
      if (this.pluginEmit) {
        await this.pluginEmit('tool:after', { tool: name, ok: false, error: message, elapsed_ms: elapsed });
      }
      if (err.name === 'AbortError') {
        const abort = new ToolError('tool execution aborted', { code: 'eabort' });
        abort.aborted = true;
        throw abort;
      }
      throw err instanceof ToolError ? err : new ToolError(message, { code: err.code ?? 'etool' });
    }
  }
}

function assertToolDef(def) {
  if (!def || typeof def !== 'object') throw new ToolError('tool def must be an object');
  if (typeof def.name !== 'string' || !/^[a-z0-9_]{1,64}$/.test(def.name)) {
    throw new ToolError(`invalid tool name: ${def?.name}`);
  }
  if (typeof def.execute !== 'function') throw new ToolError(`tool ${def.name} needs execute()`);
  if (typeof def.description !== 'string' || def.description.length === 0) {
    throw new ToolError(`tool ${def.name} needs a description`);
  }
  if (def.parameters !== undefined && (typeof def.parameters !== 'object' || def.parameters === null)) {
    throw new ToolError(`tool ${def.name} parameters must be a JSON schema object`);
  }
}

// Lightweight JSON-schema validation: types, required, enum, nested objects,
// arrays, min/maxLength. Covers what tool schemas in this codebase use.
export function validateArgs(schema, args) {
  const errors = [];
  if (!schema || schema.type !== 'object') return { ok: true, errors };
  validateObject(schema, args ?? {}, '', errors);
  return { ok: errors.length === 0, errors };
}

function validateObject(schema, value, path, errors) {
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) {
      errors.push(`${path}${key} is required`);
    }
  }
  const props = schema.properties ?? {};
  for (const [key, val] of Object.entries(value)) {
    const propSchema = props[key];
    if (!propSchema) continue; // additional properties allowed
    validateValue(propSchema, val, path ? `${path}${key}.` : `${key}.`, errors, path ? `${path}${key}` : key);
  }
}

function validateValue(schema, value, path, errors, displayPath) {
  if (value === undefined || value === null) return;
  const type = schema.type;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (type === 'string' && actual !== 'string') errors.push(`${displayPath} must be a string`);
  else if (type === 'number' || type === 'integer') {
    if (actual !== 'number' || Number.isNaN(value)) errors.push(`${displayPath} must be a number`);
    else if (type === 'integer' && !Number.isInteger(value)) errors.push(`${displayPath} must be an integer`);
  } else if (type === 'boolean' && actual !== 'boolean') errors.push(`${displayPath} must be a boolean`);
  else if (type === 'array' && actual !== 'array') errors.push(`${displayPath} must be an array`);
  else if (type === 'object' && actual !== 'object') errors.push(`${displayPath} must be an object`);

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${displayPath} must be one of: ${schema.enum.join(', ')}`);
  }
  if (type === 'string') {
    if (schema.maxLength && value.length > schema.maxLength) errors.push(`${displayPath} exceeds max length ${schema.maxLength}`);
    if (schema.minLength && value.length < schema.minLength) errors.push(`${displayPath} below min length ${schema.minLength}`);
  }
  if (type === 'array' && schema.items && actual === 'array') {
    for (let i = 0; i < value.length; i++) {
      validateValue(schema.items, value[i], `${path}${i}.`, errors, `${displayPath}[${i}]`);
    }
  }
  if (type === 'object' && actual === 'object') {
    validateObject(schema, value, path, errors);
  }
}

function normalizeResult(result) {
  if (typeof result === 'string') return { text: result };
  if (result && typeof result === 'object' && typeof result.text === 'string') return result;
  return { text: JSON.stringify(result, null, 2) };
}
