// Plugins: server-side JS modules that hook REVA lifecycle events and can
// register extra tools. Manifest = plugin.json { name, version, entry,
// description, permissions[] }. Each plugin is activated inside try/catch so a
// broken plugin can never take the harness down.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { exists, readJson } from '../util/fsx.js';
import { log } from '../util/log.js';

export const PLUGIN_PERMISSIONS = ['tools', 'events', 'network', 'filesystem', 'shell'];

export class PluginRegistry {
  constructor({ builtinDir, globalDir, projectDirs = [], contextFactory } = {}) {
    this.dirs = [builtinDir, globalDir, ...projectDirs].filter(Boolean);
    this.contextFactory = contextFactory;
    this.plugins = new Map();
    this.hooks = new Map(); // event -> [ {plugin, handler} ]
    this.pluginTools = [];  // tool defs registered by plugins
  }

  async load() {
    this.plugins.clear();
    this.hooks.clear();
    this.pluginTools = [];
    for (const dir of this.dirs) {
      if (!(await exists(dir))) continue;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pdir = path.join(dir, entry.name);
        const manifest = await readJson(path.join(pdir, 'plugin.json'), null);
        if (!manifest) continue; // not a plugin
        const record = {
          name: String(manifest.name ?? entry.name),
          version: String(manifest.version ?? '0.0.0'),
          description: String(manifest.description ?? ''),
          permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
          entry: String(manifest.entry ?? 'index.js'),
          dir: pdir,
          source: dir,
          status: 'loaded',
          error: null,
          registeredTools: [],
        };
        try {
          await this._activate(record);
          record.status = 'active';
        } catch (err) {
          record.status = 'failed';
          record.error = err.message;
          log.warn(`plugin ${record.name} failed:`, err.message);
        }
        this.plugins.set(record.name, record);
      }
    }
    return this.list();
  }

  async _activate(record) {
    if (!/^[a-z0-9_-]{2,64}$/i.test(record.name)) throw new Error(`invalid plugin name "${record.name}"`);
    for (const p of record.permissions) {
      if (!PLUGIN_PERMISSIONS.includes(p)) throw new Error(`unknown permission "${p}"`);
    }
    const entryPath = path.resolve(record.dir, record.entry);
    if (!entryPath.startsWith(path.resolve(record.dir) + path.sep)) {
      throw new Error('plugin entry escapes plugin directory');
    }
    // file:// URL required by the ESM loader on Windows absolute paths
    const mod = await import(pathToFileURL(entryPath).href);
    if (typeof mod.activate !== 'function') {
      throw new Error('plugin module must export activate(ctx)');
    }
    const ctx = this._makeContext(record);
    await mod.activate(ctx);
  }

  _makeContext(record) {
    const registry = this;
    const has = (p) => record.permissions.includes(p);
    return {
      pluginName: record.name,
      log: (...args) => log.info(`[plugin:${record.name}]`, ...args),
      permissions: [...record.permissions],
      registerTool(def) {
        if (!has('tools')) throw new Error(`plugin "${record.name}" lacks "tools" permission`);
        if (!def || typeof def.name !== 'string' || typeof def.execute !== 'function') {
          throw new Error('registerTool requires { name, description, parameters, execute }');
        }
        const namespaced = `plugin__${record.name}__${def.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        record.registeredTools.push(namespaced);
        const toolDef = {
          name: namespaced,
          description: `[plugin:${record.name}] ${def.description ?? def.name}`,
          parameters: def.parameters ?? { type: 'object', properties: {} },
          execute: def.execute,
          plugin: record.name,
        };
        registry.pluginTools.push(toolDef);
        registry.emit('plugin:tool_registered', { plugin: record.name, tool: namespaced });
        return toolDef;
      },
      on(event, handler) {
        if (!has('events')) throw new Error(`plugin "${record.name}" lacks "events" permission`);
        if (typeof handler !== 'function') throw new Error('handler must be a function');
        if (!registry.hooks.has(event)) registry.hooks.set(event, []);
        registry.hooks.get(event).push({ plugin: record.name, handler });
      },
    };
  }

  // Returns array of results; hook errors are swallowed (plugin bugs must not
  // break the agent loop) but surfaced via the returned results.
  async emit(event, payload) {
    const hooks = this.hooks.get(event) ?? [];
    const results = [];
    for (const { plugin, handler } of hooks) {
      try {
        results.push({ plugin, result: await handler(structuredClone(payload)) });
      } catch (err) {
        results.push({ plugin, error: err.message });
        log.warn(`plugin hook ${event} (${plugin}) failed:`, err.message);
      }
    }
    return results;
  }

  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      permissions: p.permissions,
      status: p.status,
      error: p.error,
      tools: p.registeredTools,
      source: p.source,
    }));
  }

  get(name) {
    return this.plugins.get(name) ?? null;
  }

  toolDefs() {
    return [...this.pluginTools];
  }
}
