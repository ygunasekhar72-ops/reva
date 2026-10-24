// AgentSession: the agent loop. Ties providers + tools + skills + plugins +
// MCP + memory together. Every visible step is appended to an EventLog (which
// the TUI and PWA render live), sessions persist as JSONL and are resumable,
// and compaction always snapshots durable notes into the project memory
// workspace first.
import path from 'node:path';
import { newId } from '../util/ids.js';
import { estimateMessagesTokens } from '../util/text.js';
import { EventLog } from './events.js';
import { MemoryManager } from './memory.js';

const MODES = ['main', 'subagent', 'bot'];

export class AgentSession {
  constructor(deps) {
    const {
      workspace, config, providers, tools, skills, plugins, mcp, audit, keystore,
      sessionsDir, sessionIndex, id, provider, model, mode = 'main', bot = null,
      depth = 0, parent = null, systemPromptExtra = '',
    } = deps;

    this.id = id ?? newId('ses');
    this.workspace = workspace;
    this.config = config;
    this.providers = providers;
    this.tools = tools;
    this.skills = skills;
    this.plugins = plugins;
    this.mcp = mcp;
    this.audit = audit;
    this.keystore = keystore;
    this.sessionIndex = sessionIndex;
    this.mode = MODES.includes(mode) ? mode : 'main';
    this.bot = bot;
    this.depth = depth;
    this.parent = parent;
    this.systemPromptExtra = systemPromptExtra;

    this.providerName = provider ?? bot?.provider ?? config.get('default_provider');
    this.model = model ?? bot?.model ?? config.get('default_model');
    this.messages = [];
    this.state = { todos: [] };
    this.usageTotals = { input_tokens: 0, output_tokens: 0, requests: 0 };
    this.iterations = 0;
    this.title = null;
    this._children = new Set();
    this._finished = false;

    this.memory = new MemoryManager({ workspace, config });
    this.sessionsDir = sessionsDir ?? this._sessionsDir();
    this.eventLog = new EventLog(path.join(this.sessionsDir, `${this.id}.jsonl`));
  }

  // ---- lifecycle -----------------------------------------------------------

  async loadHistory() {
    await this.eventLog.load();
    this.messages = rebuildMessages(this.eventLog.all());
    const lastUser = [...this.messages].reverse().find((m) => m.role === 'user');
    if (this.messages.length > 0) {
      this.title = firstLine(lastUser?.content ?? 'resumed session', 60);
      const usageEvents = this.eventLog.all().filter((e) => e.type === 'usage');
      for (const u of usageEvents) {
        this.usageTotals.input_tokens += u.usage?.input_tokens ?? 0;
        this.usageTotals.output_tokens += u.usage?.output_tokens ?? 0;
      }
    }
    return this.messages.length;
  }

  // ---- prompt --------------------------------------------------------------

  async buildSystemPrompt() {
    const parts = [];
    parts.push([
      'You are REVA, a meticulous AI agent that works directly in the user\'s project.',
      'You are running inside the REVA harness — the user sees your thinking, tool calls, and results live.',
      '',
      `Workspace: ${this.workspace}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      this.mode === 'subagent' ? 'You are a SUBAGENT: complete your assigned task, then report a concise final answer. Do not chat.' : '',
    ].filter(Boolean).join('\n'));

    if (this.bot) {
      parts.push(`\n## Bot persona: ${this.bot.name}\n${this.bot.system ?? ''}`);
    }
    if (this.systemPromptExtra) parts.push(this.systemPromptExtra);

    const skillSection = this.skills?.toPromptSection?.();
    if (skillSection) parts.push(`\n${skillSection}`);

    const memorySection = await this.memory.promptSection();
    if (memorySection) parts.push(memorySection);

    parts.push([
      '\n## Working rules',
      '- Think before acting; state your plan with the todo tool for multi-step work.',
      '- Verify your edits (run tests/builds) before claiming success.',
      '- Files must stay inside the workspace; the path guard enforces this.',
      '- Never print, copy, or exfiltrate API keys or credentials found in files.',
      '- When context grows long, you will be compacted automatically; durable facts belong in memory_save.',
      '- Be direct and concise. Your final message is shown to the user as-is.',
    ].join('\n'));

    return parts.join('\n');
  }

  // ---- tool selection ------------------------------------------------------

  toolDefs() {
    const allow = this.bot?.tools_allow ?? null;
    let defs = this.tools.defsFor();
    if (Array.isArray(allow)) defs = defs.filter((d) => allow.includes(d.name) || d.name === 'todo');
    if (this.mode === 'subagent' && this.depth >= (this.config.get('agent.max_subagent_depth') ?? 2)) {
      defs = defs.filter((d) => d.name !== 'task');
    }
    if (this.mode === 'subagent' && this.bot?.tools_allow === undefined && this.parent) {
      // default subagent: no spawning further by default beyond depth guard
    }
    return defs;
  }

  // ---- main loop -----------------------------------------------------------

  async run(input, { signal, title } = {}) {
    if (this._finished && this.mode !== 'main') throw new Error('subagent sessions are single-use');
    const text = String(input ?? '').trim();
    if (text.length === 0) throw new Error('empty input');
    if (text.length > 200000) throw new Error('input too large (200KB max)');

    if (!this.title) this.title = title ?? firstLine(text, 60);
    await this._touch();
    this._currentSignal = signal;

    await this.eventLog.append({ type: 'user_message', text });
    this.messages.push({ role: 'user', content: text });
    if (this.plugins) await this.plugins.emit('message:new', { session: this.id, text });

    try {
      const result = await this._loop({ signal });
      this._finished = true;
      await this.eventLog.append({ type: 'session_done', usage: this.usageTotals, iterations: this.iterations });
      return result;
    } catch (err) {
      const aborted = err.name === 'AbortError';
      await this.eventLog.append({ type: 'session_error', error: err.message, aborted });
      throw err;
    }
  }

  async _loop({ signal }) {
    const maxIterations = this.bot?.max_iterations ?? this.config.get('agent.max_iterations') ?? 24;
    const threshold = this.config.get('agent.compaction_threshold') ?? 24000;
    let finalText = '';

    while (true) {
      this.iterations += 1;
      if (signal?.aborted) {
        const err = new Error('aborted by user');
        err.name = 'AbortError';
        throw err;
      }

      // --- compaction with memory snapshot ---
      if (this.config.get('memory.enabled') !== false && this.memory.shouldCompact(this.messages, threshold)) {
        await this._compact({ signal });
      }

      // --- provider call ---
      const system = await this.buildSystemPrompt();
      const apiMessages = [{ role: 'system', content: system }, ...sanitizeMessages(this.messages)];
      const response = await this.providers.chat(this.providerName, {
        messages: apiMessages,
        tools: this.toolDefs(),
        model: this.model,
        temperature: this.config.get('agent.default_temperature'),
        signal: withTimeout(signal, this.config.get('agent.request_timeout_ms')),
        onEvent: (e) => {
          this.eventLog.append({ type: 'stream', iteration: this.iterations, ...e }).catch(() => {});
        },
      });

      this.usageTotals.input_tokens += response.usage?.input_tokens ?? 0;
      this.usageTotals.output_tokens += response.usage?.output_tokens ?? 0;
      this.usageTotals.requests += 1;

      const assistantMessage = {
        role: 'assistant',
        content: response.text,
        tool_calls: response.tool_calls.length > 0 ? response.tool_calls : undefined,
        provider_raw: response.raw_assistant ?? undefined,
      };
      this.messages.push(assistantMessage);
      await this.eventLog.append({
        type: 'assistant_message',
        text: response.text,
        thinking: response.thinking ?? null,
        tool_calls: response.tool_calls,
        usage: response.usage,
        stop_reason: response.stop_reason,
        iteration: this.iterations,
        provider: this.providerName,
        model: this.model,
      });
      finalText = response.text;

      if (response.stop_reason === 'tool_use' && response.tool_calls.length > 0) {
        await this._executeToolCalls(response.tool_calls, { signal });
        if (this.iterations >= maxIterations) {
          await this.eventLog.append({ type: 'max_iterations', limit: maxIterations });
          finalText = response.text || '(stopped: reached max tool iterations)';
          break;
        }
        continue;
      }
      break;
    }

    await this._touch();
    return { text: finalText, usage: { ...this.usageTotals }, iterations: this.iterations };
  }

  async _executeToolCalls(calls, { signal }) {
    // Independent tool calls run concurrently (bounded) — this is what makes
    // multi-agent fan-out via the task tool genuinely parallel.
    const limit = this.config.get('agent.max_concurrent_subagents') ?? 4;
    const results = new Array(calls.length);
    let index = 0;
    const worker = async () => {
      while (index < calls.length) {
        const i = index++;
        results[i] = await this._executeOneTool(calls[i], { signal });
      }
    };
    const workers = Array.from({ length: Math.min(limit, calls.length) }, worker);
    await Promise.all(workers);

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      const res = results[i];
      const toolMessage = {
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: res.text,
        ok: res.ok !== false,
      };
      this.messages.push(toolMessage);
      await this.eventLog.append({
        type: 'tool_message', tool_call_id: call.id, tool: call.name, ok: toolMessage.ok,
        preview: res.text.slice(0, 500),
      });
    }
  }

  async _executeOneTool(call, { signal }) {
    const ctx = {
      workspace: this.workspace,
      config: this.config,
      configApi: this.config,
      session: this,
      actor: this.bot ? `bot:${this.bot.name}` : (this.mode === 'subagent' ? 'subagent' : 'agent'),
      mode: this.mode === 'bot' ? 'server' : this._serverMode ? 'server' : 'local',
      signal,
      emit: (event) => { this.eventLog.append({ type: 'tool_event', ...event }).catch(() => {}); },
      audit: this.audit,
      keystore: this.keystore,
      skillRegistry: this.skills,
      providerRegistry: this.providers,
      mcpManager: this.mcp,
      memoryManager: this.memory,
    };
    try {
      const result = await this.tools.execute(call.name, call.arguments, ctx);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, text: `tool error: ${err.message}` };
    }
  }

  // ---- compaction ----------------------------------------------------------

  async _compact({ signal }) {
    const before = estimateMessagesTokens(this.messages);
    await this.eventLog.append({ type: 'compaction_started', estimated_tokens: before });
    if (this.audit) await this.audit.record('agent', 'memory.compact', { session: this.id, tokens_before: before });

    const { summaryMessage } = await this.memory.snapshotAndSummarize({
      messages: this.messages,
      chat: (opts) => this.providers.chat(this.providerName, {
        ...opts,
        model: this.model,
        tools: [],
        temperature: 0.1,
      }),
      signal,
      emit: (e) => this.eventLog.append(e).catch(() => {}),
    });

    const keep = this.config.get('agent.keep_recent_messages') ?? 6;
    const recent = this.messages.slice(-keep).map((m) => ({ ...m, provider_raw: undefined }));
    this.messages = [{ role: 'user', content: summaryMessage }, ...recent];
    await this.eventLog.append({
      type: 'compaction_done',
      tokens_before: before,
      tokens_after: estimateMessagesTokens(this.messages),
      kept_messages: recent.length,
    });
  }

  // ---- subagents -----------------------------------------------------------

  async spawnSubagent({ prompt, mode = 'general', provider, model, title }) {
    const maxDepth = this.config.get('agent.max_subagent_depth') ?? 2;
    const maxConcurrent = this.config.get('agent.max_concurrent_subagents') ?? 4;
    if (this.depth >= maxDepth) throw new Error(`max subagent depth (${maxDepth}) reached`);
    if (this._children.size >= maxConcurrent) throw new Error(`max concurrent subagents (${maxConcurrent}) reached`);

    const READ_ONLY = ['read', 'list', 'grep', 'web_search', 'web_fetch', 'memory_read', 'skill'];
    const sub = new AgentSession({
      workspace: this.workspace,
      config: this.config,
      providers: this.providers,
      tools: this.tools,
      skills: this.skills,
      plugins: this.plugins,
      mcp: this.mcp,
      audit: this.audit,
      keystore: this.keystore,
      sessionsDir: this.sessionsDir,
      sessionIndex: this.sessionIndex,
      provider: provider ?? this.providerName,
      model: model ?? this.model,
      mode: 'subagent',
      depth: this.depth + 1,
      parent: this.id,
      systemPromptExtra: mode === 'explore'
        ? 'Subagent mode: EXPLORE. You have read-only tools. Investigate and report findings; do not modify anything.'
        : '',
      bot: mode === 'explore' ? { name: 'explorer', tools_allow: READ_ONLY, system: '' } : null,
    });
    // explorer bots restrict tools via bot.tools_allow; general subagents inherit all tools.

    this._children.add(sub.id);
    await this.eventLog.append({ type: 'subagent_start', child: sub.id, prompt: prompt.slice(0, 500), mode });

    const unsubscribe = sub.eventLog.subscribe((e) => {
      this.eventLog.append({ type: 'subagent_event', child: sub.id, event: { type: e.type, tool: e.tool, text: typeof e.text === 'string' ? e.text.slice(0, 200) : undefined } }).catch(() => {});
    });

    try {
      const result = await sub.run(prompt, { signal: this._currentSignal, title: title ?? `subagent: ${firstLine(prompt, 40)}` });
      await this.eventLog.append({
        type: 'subagent_done', child: sub.id, iterations: result.iterations,
        usage: result.usage, summary: result.text.slice(0, 2000),
      });
      return result;
    } finally {
      unsubscribe();
      this._children.delete(sub.id);
    }
  }

  _sessionsDir() {
    return path.join(this.workspace, '.reva', 'sessions');
  }

  _currentSignal = undefined;

  setState(key, value) {
    this.state[key] = value;
    this._touch().catch(() => {});
  }

  async _touch() {
    if (!this.sessionIndex) return;
    // Best-effort: the index is a UI convenience; the JSONL event log is the
    // source of truth. An index failure must never abort an agent run.
    try {
      await this.sessionIndex.upsert({
        id: this.id,
        title: this.title ?? '(untitled)',
        provider: this.providerName,
        model: this.model,
        mode: this.mode,
        bot: this.bot?.name ?? null,
        depth: this.depth,
        parent: this.parent,
        messages: this.messages.length,
        state: { todos: this.state.todos ?? [] },
        updated_at: Date.now(),
        created_at: this._createdAt ?? (this._createdAt = Date.now()),
      });
    } catch { /* index write failed — session continues */ }
  }

  // Server-mode marker (exec disabled over network by default).
  markServerMode() {
    this._serverMode = true;
  }
}

// ---- helpers ----------------------------------------------------------------

export function rebuildMessages(events) {
  const messages = [];
  for (const e of events) {
    if (e.type === 'user_message') {
      messages.push({ role: 'user', content: e.text });
    } else if (e.type === 'assistant_message') {
      messages.push({
        role: 'assistant',
        content: e.text ?? '',
        tool_calls: e.tool_calls?.length > 0 ? e.tool_calls : undefined,
        provider_raw: undefined, // raw blocks are not persisted across resumes
      });
    } else if (e.type === 'tool_message') {
      messages.push({ role: 'tool', tool_call_id: e.tool_call_id, name: e.tool, content: e.preview ?? '', ok: e.ok });
    }
  }
  return messages;
}

export function sanitizeMessages(messages) {
  return messages.map((m) => {
    const out = { role: m.role, content: m.content };
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    if (m.provider_raw) out.provider_raw = m.provider_raw;
    return out;
  });
}

function withTimeout(signal, timeoutMs) {
  const t = AbortSignal.timeout(timeoutMs ?? 120000);
  if (!signal) return t;
  return AbortSignal.any([signal, t]);
}

function firstLine(text, max) {
  const line = String(text ?? '').split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
