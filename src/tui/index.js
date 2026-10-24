// REVA terminal UI. Inline streaming (works over SSH/Termux/Windows Terminal):
// thinking streams in dim, tool calls render as compact cards, everything the
// agent does is visible in real time. Slash commands for sessions, models,
// bots, memory. Degrades gracefully when stdin is not a TTY.
import readline from 'node:readline';
import { createHarness } from '../core/harness.js';
import { log } from '../util/log.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const INVERT = '\x1b[7m';
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export async function runTui(opts = {}) {
  const out = process.stdout;
  const tty = process.stdin.isTTY === true;
  const workspace = opts.workspace ? `${opts.workspace}` : process.cwd();

  const h = await createHarness({ workspace });
  await h.loadPlugins();
  // Best-effort MCP connect (configured servers); failures are non-fatal.
  const mcpResults = await h.connectMcpAll();
  const mcpTools = h.mcp.allTools().length;

  let session = h.createSession({});
  let provider = session.providerName;
  let model = session.model;

  banner(out, { workspace, provider, model, skills: h.skills.list().length, plugins: h.plugins.list().length, mcpTools, tty });

  let running = false;
  let abort = null;
  let spinnerTimer = null;
  let spinnerFrame = 0;

  const rl = tty
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        prompt: `${INVERT} › ${RESET} `,
      })
    : null;

  const writeLine = (s = '') => out.write(`${s}\n`);
  const dim = (s) => `${DIM}${s}${RESET}`;

  function startSpinner(label = 'thinking') {
    if (!tty) return;
    stopSpinner();
    spinnerFrame = 0;
    spinnerTimer = setInterval(() => {
      const frame = SPINNER_FRAMES[spinnerFrame++ % SPINNER_FRAMES.length];
      readline.cursorTo(out, 0);
      readline.clearLine(out, 0);
      out.write(dim(`${frame} ${label}…  (Ctrl+C interrupts)`));
    }, 90);
  }

  function stopSpinner() {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      readline.cursorTo(out, 0);
      readline.clearLine(out, 0);
    }
  }

  function subscribe(sess) {
    return sess.eventLog.subscribe((e) => renderEvent(e));
  }

  let thinkingOpen = false;
  let wroteText = false;

  function renderEvent(e) {
    switch (e.type) {
      case 'thinking':
        if (!thinkingOpen) {
          stopSpinner();
          if (wroteText) { writeLine(); wroteText = false; }
          writeLine(dim('▌ thinking:'));
          thinkingOpen = true;
        }
        out.write(dim(e.delta ?? ''));
        break;
      case 'text':
        if (thinkingOpen) { writeLine(); writeLine(); thinkingOpen = false; }
        out.write(e.delta ?? '');
        wroteText = true;
        break;
      case 'assistant_message':
        if (thinkingOpen) { writeLine(); writeLine(); thinkingOpen = false; }
        // Live runs already streamed deltas; replays print the full text here.
        if (!wroteText && (e.text ?? '').length > 0) out.write(e.text);
        if (wroteText || (e.text ?? '').length > 0) writeLine();
        wroteText = false;
        break;
      case 'tool_start':
        if (thinkingOpen) { writeLine(); writeLine(); thinkingOpen = false; }
        if (wroteText) { writeLine(); wroteText = false; }
        writeLine(`  ${BOLD}●${RESET} ${e.tool} ${summarizeArgs(e.args)}`);
        startSpinner('working');
        break;
      case 'tool_result': {
        stopSpinner();
        const mark = e.ok ? '✓' : '✗';
        writeLine(`  ${dim(`${mark} ${e.tool} (${e.elapsed_ms ?? 0}ms)`)}`);
        break;
      }
      case 'subagent_start':
        writeLine(`  ${BOLD}◈ subagent${RESET} ${dim(`(${e.mode ?? 'general'}) ${firstChars(e.prompt, 80)}`)}`);
        startSpinner('subagent working');
        break;
      case 'subagent_done':
        stopSpinner();
        writeLine(`  ${dim(`◈ subagent finished (${e.iterations} iterations)`)}`);
        break;
      case 'compaction_started':
        writeLine(`  ${dim('◌ context growing — snapshotting project memory, then compacting…')}`);
        break;
      case 'compaction_done':
        writeLine(`  ${dim(`◌ compacted ${e.tokens_before} → ${e.tokens_after} est. tokens (memory saved to .reva/memory/)`)}`);
        break;
      case 'memory_saved':
        if (e.phase === 'compaction') writeLine(`  ${dim('◌ memory snapshot written')}`);
        break;
      case 'session_error':
        writeLine(`  ${BOLD}✗ run failed:${RESET} ${e.error}`);
        break;
      case 'usage':
        // final usage rendered after run completes
        break;
      default:
        break;
    }
  }

  async function handleLine(line) {
    const text = line.trim();
    if (text.length === 0) return rl?.prompt(true);

    if (text.startsWith('/')) {
      const handled = await command(text);
      if (handled !== 'continue') rl?.prompt(true);
      return;
    }

    await runPrompt(text, { sessionRef: () => session });
  }

  async function runPrompt(text, { sessionRef, botName } = {}) {
    running = true;
    abort = new AbortController();
    let unsubscribe;
    try {
      let sess;
      if (botName) {
        sess = h.createSession({
          mode: 'bot',
          bot: { ...h.bots.get(botName) },
          provider: h.bots.get(botName).provider,
          model: h.bots.get(botName).model,
        });
      } else {
        sess = sessionRef?.();
      }
      unsubscribe = subscribe(sess);
      writeLine(`${BOLD}› ${text}${RESET}`);
      startSpinner('thinking');
      const result = await sess.run(text, { signal: abort.signal });
      stopSpinner();
      if (thinkingOpen) { writeLine(); thinkingOpen = false; }
      writeLine();
      writeLine(dim(`  ── in ${result.usage.input_tokens} tok · out ${result.usage.output_tokens} tok · ${result.iterations} turn${result.iterations === 1 ? '' : 's'}`));
      writeLine();
      if (botName) {
        await h.audit.record(`bot:${botName}`, 'bot.run', { tui: true });
      }
      return result;
    } catch (err) {
      stopSpinner();
      if (thinkingOpen) { writeLine(); thinkingOpen = false; }
      if (err.name === 'AbortError') {
        writeLine(dim('  ── interrupted'));
      } else {
        writeLine(`  ${BOLD}✗ error:${RESET} ${err.message}`);
      }
      writeLine();
    } finally {
      unsubscribe?.();
      running = false;
      abort = null;
      if (tty) rl.prompt(true);
    }
    return null;
  }
  async function command(text) {
    const [cmd, ...args] = text.slice(1).split(/\s+/);
    switch (cmd) {
      case 'help':
        writeLine(`${BOLD}commands${RESET}`);
        writeLine('  /help            this list');
        writeLine('  /new             fresh session (memory persists)');
        writeLine('  /sessions        list sessions');
        writeLine('  /resume <id>     continue a session');
        writeLine('  /provider <p>    switch provider');
        writeLine('  /model <m>       switch model');
        writeLine('  /bot <n> <task>  run a bot inline (dots, grok, …)');
        writeLine('  /bots            list bots');
        writeLine('  /skills          list skills');
        writeLine('  /tools           list tools (incl. MCP + plugins)');
        writeLine('  /memory [topic]  show project memory');
        writeLine('  /todos           current plan');
        writeLine('  /clear           clear screen');
        writeLine('  /quit            exit');
        writeLine();
        return 'continue';
      case 'new':
        session = h.createSession({});
        provider = session.providerName;
        model = session.model;
        writeLine(dim(`new session ${session.id}`));
        return 'continue';
      case 'sessions': {
        const list = h.sessionIndex.list({ limit: 10 });
        for (const s of list) writeLine(`  ${s.id}  ${dim(`[${s.mode}${s.bot ? `:${s.bot}` : ''}]`)} ${s.title}`);
        if (list.length === 0) writeLine(dim('  (none)'));
        return 'continue';
      }
      case 'resume': {
        try {
          const s = await h.resumeSession(args[0]);
          session = s;
          writeLine(dim(`resumed ${args[0]} (${s.messages.length} messages)`));
        } catch (err) {
          writeLine(`  ✗ ${err.message}`);
        }
        return 'continue';
      }
      case 'provider':
        if (args[0]) {
          session.providerName = args[0];
          provider = args[0];
          writeLine(dim(`provider → ${provider}`));
        } else writeLine(`  ${provider}`);
        return 'continue';
      case 'model':
        if (args[0]) {
          session.model = args[0];
          model = args[0];
          writeLine(dim(`model → ${model}`));
        } else writeLine(`  ${model}`);
        return 'continue';
      case 'bots':
        for (const b of h.bots.list()) writeLine(`  ${b.name.padEnd(10)} ${dim(`${b.provider}/${b.model}`)} ${b.description}`);
        return 'continue';
      case 'bot': {
        const name = args[0];
        const bot = name ? h.bots.get(name) : null;
        if (!bot) {
          writeLine(`  ✗ bot not found. installed: ${h.bots.list().map((b) => b.name).join(', ')}`);
          return 'continue';
        }
        const task = args.slice(1).join(' ').trim();
        if (!task) {
          writeLine('  usage: /bot <name> <task>');
          return 'continue';
        }
        await runPrompt(task, { botName: name });
        return 'handled';
      }
      case 'skills':
        for (const s of h.skills.list()) writeLine(`  ${s.name.padEnd(20)} ${s.description}`);
        if (h.skills.list().length === 0) writeLine(dim('  (none — add skills to .reva/skills/<name>/SKILL.md)'));
        return 'continue';
      case 'tools':
        for (const t of h.tools.defsFor()) writeLine(`  ${t.name.padEnd(20)} ${firstChars(t.description, 90)}`);
        return 'continue';
      case 'memory': {
        if (args[0]) {
          const content = await session.memory.readTopic(args[0]);
          writeLine(content ?? dim('  (no such topic)'));
        } else {
          const all = await session.memory.readAll();
          const topics = Object.keys(all.topics);
          if (topics.length === 0) writeLine(dim('  (no memory yet — agents save durable notes to .reva/memory/)'));
          for (const t of topics) writeLine(`  ${t.padEnd(20)} ${all.topics[t].split('\n').length} lines`);
        }
        return 'continue';
      }
      case 'todos': {
        const todos = session.state?.todos ?? [];
        if (todos.length === 0) writeLine(dim('  (no plan yet)'));
        for (const t of todos) writeLine(`  [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' '}] ${t.content}`);
        return 'continue';
      }
      case 'compact':
        writeLine(dim('  compacting with memory snapshot…'));
        try {
          await session._compact({ signal: undefined });
          writeLine(dim('  done.'));
        } catch (err) {
          writeLine(`  ✗ ${err.message}`);
        }
        return 'continue';
      case 'clear':
        out.write('\x1b[2J\x1b[H');
        return 'continue';
      case 'quit':
      case 'exit':
        await cleanup();
        process.exit(0);
        return 'handled';
      default:
        writeLine(`  unknown command /${cmd} — /help`);
        return 'continue';
    }
  }

  async function cleanup() {
    stopSpinner();
    await h.shutdown();
  }

  if (rl) {
    rl.on('line', (line) => {
      if (running) return; // ignore input while agent works (Ctrl+C aborts)
      handleLine(line).catch((err) => {
        writeLine(`  ✗ ${err.message}`);
        rl.prompt(true);
      });
    });

    rl.on('SIGINT', () => {
      if (running && abort) {
        abort.abort();
        return;
      }
      writeLine(dim('\n( Ctrl+C again or /quit to exit )'));
      rl.prompt(true);
    });
  }
  process.on('SIGINT', () => {
    if (running && abort) {
      abort.abort();
      return;
    }
    cleanup().then(() => process.exit(0));
  });

  if (rl) {
    rl.prompt(true);
  } else {
    // Non-interactive: read all of stdin as one prompt (scriptable / testable).
    let buffered = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) buffered += chunk;
    const text = buffered.trim();
    if (text.length > 0) {
      if (text.startsWith('/')) await command(text);
      else await runPrompt(text, { sessionRef: () => session });
    }
    await cleanup();
  }
  return 0;
}

function banner(out, { workspace, provider, model, skills, plugins, mcpTools, tty }) {
  const dimS = (s) => `${DIM}${s}${RESET}`;
  const art = [
    '█▀▄ ▄▀▄ █▀▀ █   █▀█ ▄▀█',
    '█▄▀ █▀█ ██▄ █▄▄ █▀▄ █▀█',
  ];
  if (tty) {
    out.write('\x1b[2J\x1b[H');
    out.write(`${art.join('\n')}\n`);
  } else {
    out.write('REVA agent harness\n');
  }
  out.write(`  ${dimS(`workspace ${workspace}`)}\n`);
  out.write(`  ${dimS(`${provider}/${model} · ${skills} skills · ${plugins} plugins · ${mcpTools} mcp tools`)}\n`);
  out.write(`  ${dimS('type a task, or /help — Ctrl+C interrupts the agent')}\n\n`);
}

function summarizeArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return firstChars(args, 80);
  try {
    const s = JSON.stringify(args);
    return firstChars(s, 100);
  } catch {
    return '';
  }
}

function firstChars(s, n) {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

void log;
