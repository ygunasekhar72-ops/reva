// MCP (Model Context Protocol) client over stdio transport.
// Speaks JSON-RPC 2.0 with newline-delimited frames, per the MCP spec:
//   initialize -> notifications/initialized -> tools/list -> tools/call
// Each server runs as a child process; requests are correlated by id and
// guarded by a timeout. Server notifications are surfaced via onNotification.
import { spawn } from 'node:child_process';
import { newId } from '../util/ids.js';

export class McpError extends Error {
  constructor(message, { code, server } = {}) {
    super(message);
    this.code = code ?? 'emcp';
    this.server = server;
    this.status = 502;
  }
}

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  constructor({ name, command, args = [], env = {}, cwd, timeoutMs = 20000, onNotification } = {}) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.onNotification = onNotification;
    this.proc = null;
    this.pending = new Map();
    this.buffer = '';
    this.nextId = 1;
    this.tools = [];
    this.status = 'stopped';
    this.serverInfo = null;
  }

  async start() {
    if (this.proc) return;
    this.status = 'starting';
    try {
      this.proc = spawn(this.command, this.args, {
        cwd: this.cwd ?? process.cwd(),
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      this.status = 'error';
      throw new McpError(`failed to spawn MCP server "${this.name}": ${err.message}`, { server: this.name, code: 'espawn' });
    }
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      this.lastStderr = String(chunk).slice(0, 2000);
    });
    this.proc.on('error', (err) => {
      this.status = 'error';
      this.proc = null; // failed spawn: no exit event will ever fire
      this._failAll(new McpError(`MCP server "${this.name}" error: ${err.message}`, { server: this.name }));
    });
    this.proc.on('exit', (code) => {
      this.status = 'stopped';
      this.proc = null;
      this._failAll(new McpError(`MCP server "${this.name}" exited (code ${code})`, { server: this.name, code: 'eexit' }));
    });

    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {}, resources: {}, prompts: {} },
      clientInfo: { name: 'reva-harness', version: '1.0.0' },
    });
    this.serverInfo = result?.serverInfo ?? null;
    this.notify('notifications/initialized', {});
    this.status = 'running';
    return result;
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new McpError(msg.error.message ?? 'MCP error', { code: `mcp_${msg.error.code}`, server: this.name }));
          } else {
            pending.resolve(msg.result);
          }
        }
      } else if (msg.method) {
        try { this.onNotification?.(msg); } catch { /* listener errors are not fatal */ }
      }
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method, params, { timeoutMs } = {}) {
    if (!this.proc || this.status === 'stopped') {
      return Promise.reject(new McpError(`MCP server "${this.name}" is not running`, { server: this.name }));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError(`MCP request "${method}" timed out after ${timeoutMs ?? this.timeoutMs}ms`, { server: this.name, code: 'etimeout' }));
      }, timeoutMs ?? this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new McpError(`MCP write failed: ${err.message}`, { server: this.name }));
      }
    });
  }

  notify(method, params) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
    } catch { /* server went away */ }
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    this.tools = (result?.tools ?? []).map((t) => ({
      // Normalize into REVA's internal tool shape; MCP inputSchema is
      // JSON-Schema so it maps directly to our `parameters`.
      name: this.mcpToolName(t.name),
      description: t.description ?? `MCP tool ${t.name} from server ${this.name}`,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
      mcp: true,
      mcp_server: this.name,
      mcp_tool: t.name,
    }));
    return this.tools;
  }

  mcpToolName(raw) {
    // Namespaced so they cannot collide with built-ins or other servers.
    return `mcp__${this.name}__${raw}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  async callTool(rawName, args, opts = {}) {
    const result = await this.request('tools/call', { name: rawName, arguments: args ?? {} }, opts);
    const isError = result?.isError === true;
    const text = (result?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`))
      .join('\n');
    return { ok: !isError, content: text || '(empty result)', raw: result };
  }

  async stop() {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.status = 'stopped';
    this._failAll(new McpError(`MCP server "${this.name}" stopped by client`, { server: this.name }));
    try { proc.stdin.end(); } catch { /* already closed */ }
    // A crashed/failed spawn may never emit 'exit'; never wait more than 2s.
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    const killer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* gone */ }
    }, 2000);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
    clearTimeout(killer);
  }
}

// Manager owns the set of configured servers for a project.
export class McpManager {
  constructor({ config, cwd, onEvent } = {}) {
    this.config = config;
    this.cwd = cwd;
    this.onEvent = onEvent;
    this.clients = new Map();
  }

  configuredServers() {
    return this.config.get('mcp.servers') ?? {};
  }

  async connect(name) {
    const servers = this.configuredServers();
    const scfg = servers[name];
    if (!scfg) throw new McpError(`no MCP server configured as "${name}"`, { server: name });
    if (scfg.enabled === false) throw new McpError(`MCP server "${name}" is disabled`, { server: name });
    let client = this.clients.get(name);
    if (client && client.status === 'running') return client;
    if (!client) {
      client = new McpClient({
        name,
        command: scfg.command,
        args: scfg.args ?? [],
        env: scfg.env ?? {},
        cwd: this.cwd,
        timeoutMs: this.config.get('mcp.call_timeout_ms') ?? 20000,
        onNotification: (msg) => this.onEvent?.({ type: 'mcp_notification', server: name, notification: msg }),
      });
      this.clients.set(name, client);
    }
    await client.start();
    await client.listTools();
    return client;
  }

  async connectAll() {
    const results = {};
    for (const name of Object.keys(this.configuredServers())) {
      try {
        await this.connect(name);
        results[name] = { ok: true, tools: this.clients.get(name).tools.length };
      } catch (err) {
        results[name] = { ok: false, error: err.message };
      }
    }
    return results;
  }

  // All tools from all running servers, normalized.
  allTools() {
    const out = [];
    for (const client of this.clients.values()) {
      if (client.status === 'running') out.push(...client.tools);
    }
    return out;
  }

  async call(namespacedName, args) {
    for (const client of this.clients.values()) {
      const tool = client.tools.find((t) => t.name === namespacedName);
      if (tool) {
        const res = await client.callTool(tool.mcp_tool, args);
        this.onEvent?.({ type: 'mcp_call', server: client.name, tool: tool.mcp_tool, ok: res.ok });
        return res;
      }
    }
    throw new McpError(`no running MCP server provides tool "${namespacedName}"`, { code: 'enotool' });
  }

  status() {
    return [...this.clients.entries()].map(([name, c]) => ({
      name,
      status: c.status,
      command: c.command,
      tools: c.tools.map((t) => t.name),
      serverInfo: c.serverInfo,
    }));
  }

  async stopAll() {
    await Promise.allSettled([...this.clients.values()].map((c) => c.stop()));
    this.clients.clear();
  }
}

export { newId };
