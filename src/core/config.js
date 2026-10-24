// REVA configuration: global (~/.reva/config.json) merged under project
// (.reva/config.json). Merge is prototype-pollution safe.
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic, exists } from '../util/fsx.js';
import { deepMerge } from '../util/merge.js';

export const REVA_DIRNAME = '.reva';

export function globalDir() {
  return path.join(os.homedir(), REVA_DIRNAME);
}
export function globalFile(name) {
  return path.join(globalDir(), name);
}
export function projectDir(projectRoot) {
  return path.join(projectRoot, REVA_DIRNAME);
}
export function projectFile(projectRoot, name) {
  return path.join(projectDir(projectRoot), name);
}

export const DEFAULT_CONFIG = {
  version: 1,
  server: {
    host: '127.0.0.1',
    port: 7463,
    // When false, the HTTP API requires a logged-in session for everything
    // except GET /health and POST /api/auth/login.
    allow_anonymous_local: false,
  },
  agent: {
    max_iterations: 24,
    // Estimated tokens; compaction + memory snapshot triggers above this.
    compaction_threshold: 24000,
    keep_recent_messages: 6,
    max_subagent_depth: 2,
    max_concurrent_subagents: 4,
    default_temperature: 0.4,
    request_timeout_ms: 120000,
  },
  providers: {
    // provider_key -> { kind, base_url, model, api_key_env }
    openai:   { kind: 'openai',      base_url: 'https://api.openai.com/v1',      api_key_env: 'OPENAI_API_KEY' },
    anthropic:{ kind: 'anthropic',   base_url: 'https://api.anthropic.com',      api_key_env: 'ANTHROPIC_API_KEY' },
    gemini:   { kind: 'gemini',      base_url: 'https://generativelanguage.googleapis.com', api_key_env: 'GEMINI_API_KEY' },
    grok:     { kind: 'openai',      base_url: 'https://api.x.ai/v1',            api_key_env: 'XAI_API_KEY' },
    deepseek: { kind: 'openai',      base_url: 'https://api.deepseek.com/v1',    api_key_env: 'DEEPSEEK_API_KEY' },
    openrouter:{ kind: 'openai',     base_url: 'https://openrouter.ai/api/v1',   api_key_env: 'OPENROUTER_API_KEY' },
  },
  default_provider: 'openai',
  default_model: 'gpt-4o-mini',
  tools: {
    exec: {
      enabled: true,
      timeout_ms: 30000,
      max_output_bytes: 200000,
      // 'confirm' -> dangerous commands need confirmed=true (default);
      // 'block'    -> dangerous commands are refused outright;
      // 'audit'    -> allowed but logged.
      dangerous_mode: 'confirm',
      // Server/PWA sessions keep exec disabled unless explicitly enabled.
      enabled_over_server: false,
    },
    web: {
      allow_private_addresses: false,
      allowed_hosts: [],
      blocked_hosts: [],
      max_bytes: 2000000,
    },
  },
  mcp: {
    // name -> { command, args, env, enabled }
    servers: {},
    call_timeout_ms: 20000,
  },
  bots: {
    concurrent_limit: 3,
  },
  security: {
    login_max_attempts: 5,
    lockout_ms: 15 * 60 * 1000,
    session_ttl_ms: 12 * 60 * 60 * 1000,
    api_rate: { window_ms: 60000, max_requests: 240 },
    auth_rate: { window_ms: 60000, max_requests: 10 },
    max_body_bytes: 2 * 1024 * 1024,
  },
  memory: {
    enabled: true,
    topics: ['decisions', 'facts', 'todos', 'gotchas'],
  },
};

export class Config {
  constructor({ global = {}, project = {} } = {}) {
    this.global = global;
    this.project = project;
    this.data = deepMerge(DEFAULT_CONFIG, global);
    this.data = deepMerge(this.data, project);
  }

  get(key) {
    return key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), this.data);
  }

  raw() {
    return this.data;
  }
}

export async function loadConfig(projectRoot = process.cwd()) {
  const global = await readJson(globalFile('config.json'), {});
  const project = await readJson(projectFile(projectRoot, 'config.json'), {});
  return new Config({ global, project });
}

export async function saveProjectConfig(projectRoot, patch) {
  const file = projectFile(projectRoot, 'config.json');
  const current = await readJson(file, {});
  const next = deepMerge(current, patch);
  await writeJsonAtomic(file, next);
  return next;
}

export async function configExists(projectRoot) {
  return exists(projectFile(projectRoot, 'config.json'));
}
