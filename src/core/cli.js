// REVA CLI. Commands:
//   reva                     interactive TUI (default)
//   reva serve               headless server + mobile PWA
//   reva run "task"          one-shot agent run (automation-friendly)
//   reva auth init|status|key
//   reva sessions list|show
//   reva bot list|run|add|remove
//   reva auto list|add|remove|daemon
//   reva mcp list|connect|call
//   reva skill list|show | plugin list | memory show|snapshot
//   reva doctor | version | help
import readline from 'node:readline';
import path from 'node:path';
import { createHarness, APP_ROOT } from './harness.js';
import { RevaServer } from '../server/index.js';
import { loadConfig, globalFile } from './config.js';
import { Keystore } from '../security/crypto.js';
import { log } from '../util/log.js';

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseFlags(rest);
  switch (cmd ?? 'chat') {
    case 'chat':
    case 'tui': {
      const { runTui } = await import('../tui/index.js');
      return runTui(opts);
    }
    case 'serve': return cmdServe(opts);
    case 'run': return cmdRun(opts);
    case 'auth': return cmdAuth(opts);
    case 'sessions': return cmdSessions(opts);
    case 'bot': return cmdBot(opts);
    case 'auto': return cmdAuto(opts);
    case 'mcp': return cmdMcp(opts);
    case 'skill': return cmdSkill(opts);
    case 'plugin': return cmdPlugin(opts);
    case 'memory': return cmdMemory(opts);
    case 'doctor': return cmdDoctor(opts);
    case 'version': case '--version': case '-v':
      console.log('REVA 1.0.0 — zero-dependency agent harness');
      return 0;
    case 'help': case '--help': case '-h':
      printHelp();
      return 0;
    default:
      console.error(`unknown command: ${cmd} (try 'reva help')`);
      return 2;
  }
}

// ---- flag parsing -----------------------------------------------------------

function parseFlags(args) {
  const opts = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace' || a === '-w') opts.workspace = args[++i];
    else if (a === '--provider' || a === '-p') opts.provider = args[++i];
    else if (a === '--model' || a === '-m') opts.model = args[++i];
    else if (a === '--bot' || a === '-b') opts.bot = args[++i];
    else if (a === '--port') opts.port = Number(args[++i]);
    else if (a === '--host') opts.host = args[++i];
    else if (a === '--key') opts.key = args[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--yes') opts.yes = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = args[++i] ?? true;
    else opts._.push(a);
  }
  return opts;
}

async function harnessFor(opts) {
  const workspace = path.resolve(opts.workspace ?? process.cwd());
  return createHarness({ workspace });
}

// ---- serve -------------------------------------------------------------------

async function cmdServe(opts) {
  const h = await harnessFor(opts);
  await h.loadPlugins();
  if (opts.port) h.config.data.server.port = opts.port;
  if (opts.host) h.config.data.server.host = opts.host;
  const server = new RevaServer({ harness: h, host: opts.host, port: opts.port });
  const addr = await server.listen();
  h.startScheduler();
  const { hostname } = await import('node:os');
  console.log(`REVA server listening on http://${addr.host === '0.0.0.0' ? 'localhost' : addr.host}:${addr.port}`);
  console.log(`  workspace : ${h.workspace}`);
  console.log(`  host      : ${hostname}`);
  console.log('  open the URL on your phone (same network) → "Add to Home Screen" installs the app.');
  console.log('  Ctrl+C to stop.');
  const shutdown = async () => {
    console.log('\nshutting down…');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
  return 0;
}

// ---- run (one-shot) ------------------------------------------------------------

async function cmdRun(opts) {
  const prompt = opts._.join(' ').trim();
  if (!prompt) {
    console.error('usage: reva run "your task" [--provider X] [--model Y] [--bot name] [--json]');
    return 2;
  }
  const h = await harnessFor(opts);
  await h.loadPlugins();

  if (opts.key && opts.provider) {
    h.config.data.providers[opts.provider] = {
      ...h.config.data.providers[opts.provider],
      api_key: opts.key,
    };
  }

  const emit = opts.json
    ? (e) => process.stdout.write(`${JSON.stringify(e)}\n`)
    : (e) => renderEventCompact(e);

  try {
    let result;
    if (opts.bot) {
      result = await h.runBot(opts.bot, prompt);
    } else {
      const session = h.createSession({
        provider: opts.provider,
        model: opts.model,
        mode: opts.bot ? 'bot' : 'main',
      });
      const unsubscribe = session.eventLog.subscribe(emit);
      try {
        result = await session.run(prompt);
      } finally {
        unsubscribe();
      }
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ type: 'final', text: result.text, usage: result.usage })}\n`);
    } else {
      console.log(`\n${result.text}`);
    }
    return result.usage ? 0 : 0;
  } catch (err) {
    if (err.name === 'AbortError') return 130;
    console.error(`run failed: ${err.message}`);
    return 1;
  } finally {
    await h.shutdown();
  }
}

function renderEventCompact(e) {
  switch (e.type) {
    case 'thinking':
      process.stderr.write(`  ▌ ${e.delta ?? ''}`);
      break;
    case 'tool_start':
      process.stderr.write(`  ● ${e.tool}…\n`);
      break;
    case 'tool_result':
      process.stderr.write(`  ${e.ok ? '✓' : '✗'} ${e.tool} (${e.elapsed_ms}ms)\n`);
      break;
    case 'compaction_started':
      process.stderr.write('  ◌ compacting (memory snapshot first)…\n');
      break;
    case 'compaction_done':
      process.stderr.write(`  ◌ compacted: ${e.tokens_before} → ${e.tokens_after} est. tokens\n`);
      break;
    default:
      break;
  }
}

// ---- auth ----------------------------------------------------------------------

async function cmdAuth(opts) {
  const [sub, ...rest] = opts._;
  const h = await harnessFor(opts);
  if (sub === 'init') {
    if (h.accounts.count > 0) {
      console.log('an admin account already exists. Use `reva auth status`.');
      return 1;
    }
    const username = rest[0] ?? (await promptLine('username: '));
    const password = await promptHidden('password (min 8 chars): ');
    const password2 = await promptHidden('repeat password: ');
    if (password !== password2) {
      console.error('passwords do not match');
      return 1;
    }
    const account = await h.accounts.register(username, password);
    await h.createKeystore(password);
    await h.audit.record(username, 'auth.register', { cli: true });
    console.log(`account created: ${account.username} (${account.role})`);
    console.log('keystore created — provider API keys are now encrypted at rest.');
    console.log('add a key:  reva auth key openai sk-...');
    return 0;
  }
  if (sub === 'status') {
    console.log(`accounts   : ${h.accounts.count}`);
    console.log(`keystore   : ${h.keystore.sealed().exists ? (h.keystore.unlocked ? 'unlocked' : 'locked (sealed)') : 'not created'}`);
    console.log(`keys stored: ${h.keystore.listNames().join(', ') || '(none)'}`);
    for (const name of h.providers.providerNames()) {
      const viaEnv = h.providers.getProviderConfig(name).api_key_env;
      const envOk = viaEnv && process.env[viaEnv];
      console.log(`provider ${name.padEnd(12)} ${h.providers.isConfigured(name) ? 'configured' : envOk ? 'via env' : 'NOT configured'}`);
    }
    return 0;
  }
  if (sub === 'key') {
    const provider = rest[0];
    if (!provider) {
      console.error('usage: reva auth key <provider> [api-key]');
      return 2;
    }
    if (!h.providers.providerNames().includes(provider)) {
      console.error(`unknown provider: ${provider}`);
      return 2;
    }
    let key = rest[1];
    if (!key) key = await promptHidden(`API key for ${provider}: `);
    if (!h.keystore.unlocked) {
      if (h.keystore.sealed().exists) {
        const master = await promptHidden('master password: ');
        await h.unlockKeystore(master);
      } else {
        const master = await promptHidden('choose master password (min 8): ');
        await h.createKeystore(master);
      }
    }
    await h.keystore.setSecret(`provider:${provider}`, key);
    await h.audit.record('cli', 'keys.set', { provider });
    console.log(`key for ${provider} stored (encrypted).`);
    return 0;
  }
  console.error('usage: reva auth init|status|key');
  return 2;
}

// ---- sessions --------------------------------------------------------------------

async function cmdSessions(opts) {
  const h = await harnessFor(opts);
  const [sub, id] = opts._;
  if (sub === 'show' && id) {
    const meta = h.sessionIndex.get(id);
    if (!meta) {
      console.error('session not found');
      return 1;
    }
    console.log(JSON.stringify(meta, null, 2));
    return 0;
  }
  const list = h.sessionIndex.list();
  if (list.length === 0) {
    console.log('(no sessions yet)');
    return 0;
  }
  for (const s of list) {
    console.log(`${s.id}  ${new Date(s.updated_at).toISOString().slice(0, 16)}  [${s.mode}${s.bot ? `:${s.bot}` : ''}] ${s.title}`);
  }
  return 0;
}

// ---- bots --------------------------------------------------------------------------

async function cmdBot(opts) {
  const h = await harnessFor(opts);
  const [sub, name, ...rest] = opts._;
  if (sub === 'list') {
    for (const b of h.bots.list()) {
      console.log(`${b.name.padEnd(10)} ${b.provider}/${b.model}  ${b.description}`);
    }
    return 0;
  }
  if (sub === 'run' && name) {
    const prompt = rest.join(' ').trim();
    if (!prompt) {
      console.error('usage: reva bot run <name> "task"');
      return 2;
    }
    const result = await h.runBot(name, prompt);
    console.log(result.text);
    return 0;
  }
  if (sub === 'add' && name) {
    await h.bots.upsert({
      name,
      description: rest.join(' ') || `bot ${name}`,
      provider: opts.provider ?? h.config.get('default_provider'),
      model: opts.model ?? h.config.get('default_model'),
      system: opts.system ?? '',
    });
    console.log(`bot "${name}" saved (${opts.provider ?? 'default'}/${opts.model ?? 'default'}).`);
    return 0;
  }
  if (sub === 'remove' && name) {
    const ok = await h.bots.remove(name);
    console.log(ok ? `bot "${name}" removed.` : 'not found.');
    return ok ? 0 : 1;
  }
  console.error('usage: reva bot list|run|add|remove');
  return 2;
}

// ---- automation ------------------------------------------------------------------------

async function cmdAuto(opts) {
  const h = await harnessFor(opts);
  const [sub, id, ...rest] = opts._;
  if (sub === 'list') {
    const jobs = h.automation.list();
    if (jobs.length === 0) {
      console.log('(no automation jobs)');
      return 0;
    }
    for (const j of jobs) {
      const sched = j.schedule.every_ms ? `every ${Math.round(j.schedule.every_ms / 60000)}m` : `daily @${j.schedule.daily_at}`;
      console.log(`${j.id}  [${j.enabled ? 'on ' : 'off'}] ${j.name}  ${sched}  bot=${j.bot ?? 'agent'}  runs=${j.run_count ?? 0} last=${j.last_status ?? '-'}`);
    }
    return 0;
  }
  if (sub === 'add') {
    const name = id;
    const prompt = rest.join(' ').trim();
    if (!name || !prompt) {
      console.error('usage: reva auto add <name> "prompt" --every-minutes N | --daily-at HH:MM [--bot name]');
      return 2;
    }
    const schedule = {};
    if (opts['every-minutes']) schedule.every_ms = Math.max(1, Number(opts['every-minutes'])) * 60000;
    else if (opts['daily-at']) schedule.daily_at = String(opts['daily-at']);
    const job = await h.automation.add({ name, prompt, schedule, bot: opts.bot ?? null });
    console.log(`job added: ${job.id}`);
    return 0;
  }
  if (sub === 'remove' && id) {
    const ok = await h.automation.remove(id);
    console.log(ok ? 'removed' : 'not found');
    return ok ? 0 : 1;
  }
  if (sub === 'daemon') {
    h.startScheduler();
    console.log('automation daemon running (Ctrl+C to stop)…');
    process.on('SIGINT', () => process.exit(0));
    await new Promise(() => {});
    return 0;
  }
  console.error('usage: reva auto list|add|remove|daemon');
  return 2;
}

// ---- mcp ---------------------------------------------------------------------------------

async function cmdMcp(opts) {
  const h = await harnessFor(opts);
  const [sub, name, ...rest] = opts._;
  if (sub === 'list') {
    const servers = h.mcp.configuredServers();
    const keys = Object.keys(servers);
    if (keys.length === 0) {
      console.log('no MCP servers configured. Add to .reva/config.json:');
      console.log('  { "mcp": { "servers": { "myserver": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } } }');
      return 0;
    }
    for (const k of keys) {
      console.log(`${k}: ${servers[k].command} ${(servers[k].args ?? []).join(' ')}`);
    }
    return 0;
  }
  if (sub === 'connect') {
    const results = name ? { [name]: await safeConnect(() => h.mcp.connect(name)) } : await h.connectMcpAll();
    for (const [k, r] of Object.entries(results)) {
      console.log(`${k}: ${r.ok ? `connected, ${r.tools} tools` : `FAILED: ${r.error}`}`);
    }
    await h.shutdown();
    return 0;
  }
  if (sub === 'call' && name) {
    await h.connectMcpAll();
    const tool = rest[0];
    const args = rest[1] ? JSON.parse(rest[1]) : {};
    const result = await h.mcp.call(name, args).catch(() => h.mcp.call(tool, args));
    console.log(result.content);
    await h.shutdown();
    return 0;
  }
  console.error('usage: reva mcp list|connect|call');
  return 2;
}

async function safeConnect(fn) {
  try {
    const client = await fn();
    return { ok: true, tools: client.tools.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---- skills / plugins / memory -------------------------------------------------------------

async function cmdSkill(opts) {
  const h = await harnessFor(opts);
  const [sub, name] = opts._;
  if (sub === 'show' && name) {
    const skill = h.skills.get(name);
    if (!skill) {
      console.error('skill not found');
      return 1;
    }
    console.log(`# ${skill.name}\n${skill.body}`);
    return 0;
  }
  for (const s of h.skills.list()) {
    console.log(`${s.name.padEnd(24)} ${s.description}`);
  }
  return 0;
}

async function cmdPlugin(opts) {
  const h = await harnessFor(opts);
  await h.loadPlugins();
  const plugins = h.plugins.list();
  if (plugins.length === 0) {
    console.log('(no plugins installed)');
    return 0;
  }
  for (const p of plugins) {
    console.log(`${p.name}@${p.version} [${p.status}] ${p.description} tools=${p.tools.join(',') || '-'}`);
  }
  return 0;
}

async function cmdMemory(opts) {
  const h = await harnessFor(opts);
  const [sub, topic] = opts._;
  const dir = path.join(h.workspace, '.reva', 'memory');
  if (sub === 'snapshot') {
    console.error('snapshot runs inside an agent session (it needs the model). Start a session and let compaction happen, or ask the agent to call memory_save.');
    return 1;
  }
  if (sub === 'read' && topic) {
    const { MemoryManager } = await import('../agent/memory.js');
    const mem = new MemoryManager({ workspace: h.workspace, config: h.config });
    const content = await mem.readTopic(topic);
    console.log(content ?? '(no such topic)');
    return content ? 0 : 1;
  }
  const { MemoryManager } = await import('../agent/memory.js');
  const mem = new MemoryManager({ workspace: h.workspace, config: h.config });
  const all = await mem.readAll();
  const topics = Object.keys(all.topics);
  if (topics.length === 0) {
    console.log(`(no memory yet — it lives in ${dir})`);
    return 0;
  }
  for (const t of topics) {
    console.log(`== ${t} ==`);
    console.log(all.topics[t]);
  }
  return 0;
}

// ---- doctor ----------------------------------------------------------------------------------

async function cmdDoctor() {
  console.log('REVA doctor');
  console.log(`  node      : ${process.version} (need >=18.17) ${ok(Number(process.version.slice(1).split('.')[0]) >= 18)}`);
  console.log(`  app root  : ${APP_ROOT}`);
  console.log(`  global dir: ${globalFile('')}`);
  const cfg = await loadConfig(process.cwd());
  console.log(`  workspace : ${process.cwd()}`);
  console.log(`  providers : ${Object.keys(cfg.get('providers')).join(', ')}`);
  const h = await createHarness({ workspace: process.cwd() });
  console.log(`  skills    : ${h.skills.list().length}`);
  console.log(`  tools     : ${h.tools.names().join(', ')}`);
  console.log(`  accounts  : ${h.accounts.count}`);
  console.log(`  keystore  : ${h.keystore.sealed().exists ? 'created' : 'not created (reva auth init)'}`);
  const auditCheck = await h.audit.verify();
  console.log(`  audit log : ${auditCheck.ok ? 'chain intact' : `CHAIN BROKEN at ${auditCheck.brokenAt}`}`);
  await h.shutdown();
  return 0;
}

const ok = (b) => (b ? '✓' : '✗');

// ---- prompts ------------------------------------------------------------------------------------

function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const chars = [];
    let wasRaw = false;
    try {
      wasRaw = process.stdin.isRaw ?? false;
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
    } catch { /* not a TTY */ }
    const onData = (ch) => {
      const c = ch.toString();
      if (c === '\r' || c === '\n') {
        process.stdin.removeListener('data', onData);
        if (process.stdin.isTTY) {
          try { process.stdin.setRawMode(wasRaw); } catch { /* noop */ }
        }
        process.stdout.write('\n');
        resolve(chars.join(''));
      } else if (c === '\u0003') {
        process.exit(130);
      } else if (c === '\u007f' || c === '\b') {
        chars.pop();
      } else {
        chars.push(c);
      }
    };
    process.stdin.on('data', onData);
  });
}

function printHelp() {
  console.log(`REVA — zero-dependency AI agent harness (terminal + mobile PWA)

  reva                        interactive terminal UI
  reva serve [--port N]       HTTP API + mobile PWA (open on your phone)
  reva run "task"             one-shot run; flags: --provider --model --bot --key --json
  reva auth init|status|key   account + encrypted keystore + provider keys
  reva sessions list|show     session history
  reva bot list|run|add|remove   bots (dots, grok, your own)
  reva auto list|add|remove|daemon   scheduled automation
  reva mcp list|connect|call  MCP servers (stdio)
  reva skill list|show        skills catalog
  reva plugin list            installed plugins
  reva memory [read topic]    project AI memory
  reva doctor                 environment + integrity check
  reva version | help

Project state lives in <workspace>/.reva/ — memory, sessions, bots, audit log.
Docs: docs/ in the REVA folder.`);
}
