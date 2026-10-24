// Harness wiring: builds the full REVA runtime for one workspace. This is the
// single place where subsystems are instantiated and connected.
import path from 'node:path';
import { loadConfig, globalFile, projectFile } from './config.js';
import { AccountStore } from '../security/accounts.js';
import { SessionStore } from '../security/sessions.js';
import { Keystore } from '../security/crypto.js';
import { AuditLog } from '../security/audit.js';
import { ProviderRegistry } from '../providers/index.js';
import { ToolRegistry } from '../tools/index.js';
import { execTool } from '../tools/exec.js';
import { readTool, writeTool, editTool, listTool, grepTool } from '../tools/fs.js';
import { webSearchTool, webFetchTool } from '../tools/web.js';
import { skillTool, memorySaveTool, memoryReadTool, todoTool } from '../tools/memory.js';
import { taskTool } from '../tools/task.js';
import { SkillRegistry } from '../skills/index.js';
import { PluginRegistry } from '../plugins/index.js';
import { ExtensionRegistry } from '../extensions/index.js';
import { BotRegistry } from '../bots/index.js';
import { AutomationStore, Scheduler } from '../bots/automation.js';
import { McpManager } from '../mcp/client.js';
import { AgentSession } from '../agent/agent.js';
import { SessionIndex } from '../agent/events.js';
import { fileURLToPath } from 'node:url';
import { ensureDir, exists } from '../util/fsx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(__dirname, '..', '..');

export async function createHarness({ workspace = process.cwd(), config = null } = {}) {
  workspace = path.resolve(workspace);
  const cfg = config ?? (await loadConfig(workspace));

  const globalHome = globalFile('');
  await ensureDir(globalHome);
  await ensureDir(path.join(workspace, '.reva'));

  const audit = new AuditLog(path.join(workspace, '.reva', 'audit.log'));
  await audit.load();

  const accounts = new AccountStore(globalFile('accounts.json'), {
    maxAttempts: cfg.get('security.login_max_attempts'),
    lockoutMs: cfg.get('security.lockout_ms'),
  });
  await accounts.load();

  const sessions = new SessionStore(globalFile('sessions.json'), {
    ttlMs: cfg.get('security.session_ttl_ms'),
  });
  await sessions.load();

  const keystore = new Keystore(globalFile('keystore.json'));
  await keystore.loadSealed();

  const providers = new ProviderRegistry({ config: cfg, keystore });

  const skills = new SkillRegistry({
    builtinDir: path.join(APP_ROOT, 'skills'),
    globalDir: globalFile('skills'),
    projectDirs: [path.join(workspace, '.reva', 'skills'), path.join(workspace, 'skills')],
  });
  await skills.load();

  const plugins = new PluginRegistry({
    builtinDir: path.join(APP_ROOT, 'plugins'),
    globalDir: globalFile('plugins'),
    projectDirs: [path.join(workspace, '.reva', 'plugins'), path.join(workspace, 'plugins')],
  });

  const extensions = new ExtensionRegistry({
    builtinDir: path.join(APP_ROOT, 'extensions'),
    globalDir: globalFile('extensions'),
    projectDirs: [path.join(workspace, '.reva', 'extensions'), path.join(workspace, 'extensions')],
  });
  await extensions.load();

  const bots = new BotRegistry(projectFile(workspace, 'bots.json'));
  await bots.load();

  const automation = new AutomationStore(projectFile(workspace, 'automation.json'));
  await automation.load();

  const mcp = new McpManager({
    config: cfg,
    cwd: workspace,
    onEvent: () => {},
  });

  const toolRegistry = new ToolRegistry({ audit });
  toolRegistry.registerAll([
    execTool, readTool, writeTool, editTool, listTool, grepTool,
    webSearchTool, webFetchTool, skillTool, memorySaveTool, memoryReadTool, todoTool, taskTool,
  ]);

  const sessionsDir = path.join(workspace, '.reva', 'sessions');
  await ensureDir(sessionsDir);
  const sessionIndex = new SessionIndex(path.join(sessionsDir, 'index.json'));
  await sessionIndex.load();

  const harness = {
    workspace,
    config: cfg,
    audit,
    accounts,
    sessions,
    keystore,
    providers,
    skills,
    plugins,
    extensions,
    bots,
    automation,
    mcp,
    tools: toolRegistry,
    sessionsDir,
    sessionIndex,
    scheduler: null,
    _openAgentSessions: new Set(),

    async loadPlugins() {
      await plugins.load();
      toolRegistry.registerAll(plugins.toolDefs());
      toolRegistry.setPluginEmit((event, payload) => plugins.emit(event, payload));
      return plugins.list();
    },

    async unlockKeystore(password) {
      const result = await keystore.unlock(password);
      return result;
    },

    async createKeystore(password) {
      await keystore.create(password);
      return keystore.sealed();
    },

    createSession(opts = {}) {
      const session = new AgentSession({
        workspace,
        config: cfg,
        providers,
        tools: toolRegistry,
        skills,
        plugins,
        mcp,
        audit,
        keystore,
        sessionsDir,
        sessionIndex,
        ...opts,
      });
      harness._openAgentSessions.add(session);
      return session;
    },

    async resumeSession(id) {
      const session = harness.createSession({ id, mode: 'main' });
      const count = await session.loadHistory();
      if (count === 0) throw new Error(`session "${id}" not found or empty`);
      return session;
    },

    async runBot(botName, prompt, { signal, mode } = {}) {
      const bot = bots.get(botName);
      if (!bot) throw new Error(`bot "${botName}" not found. Installed: ${bots.list().map((b) => b.name).join(', ')}`);
      const session = harness.createSession({
        mode: 'bot',
        bot: { ...bot },
        provider: bot.provider,
        model: bot.model,
      });
      if (mode === 'server') session.markServerMode();
      await audit.record(`bot:${botName}`, 'bot.run', { bot: botName, prompt: prompt.slice(0, 200) });
      try {
        return await session.run(prompt, { signal, title: `bot ${botName}: ${prompt.slice(0, 40)}` });
      } finally {
        harness._openAgentSessions.delete(session);
      }
    },

    async connectMcpAll() {
      return mcp.connectAll();
    },

    startScheduler() {
      if (harness.scheduler) return harness.scheduler;
      harness.scheduler = new Scheduler({
        store: automation,
        onEvent: () => {},
        runJob: async (job) => {
          if (job.bot) {
            await harness.runBot(job.bot, job.prompt, { mode: 'server' });
          } else {
            const session = harness.createSession({ mode: 'bot' });
            session.markServerMode();
            try {
              await session.run(job.prompt, { title: `auto: ${job.name}` });
            } finally {
              harness._openAgentSessions.delete(session);
            }
          }
        },
      });
      harness.scheduler.start();
      return harness.scheduler;
    },

    async shutdown() {
      harness.scheduler?.stop();
      await mcp.stopAll();
      for (const s of harness._openAgentSessions) harness._openAgentSessions.delete(s);
    },
  };

  return harness;
}

export async function harnessNeedsBootstrap(harness) {
  const keystoreFile = globalFile('keystore.json');
  const hasKeystore = await exists(keystoreFile);
  return {
    needs_account: harness.accounts.count === 0,
    needs_keystore: !hasKeystore,
    accounts: harness.accounts.count,
  };
}
