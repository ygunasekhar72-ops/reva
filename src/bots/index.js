// Bots: named agent presets that run on the user's own provider keys and
// chosen models (e.g. "dots" on OpenAI, "grok" on xAI). Bots can be run
// one-shot, interactively, or scheduled by the automation engine.
// Stored per project in <project>/.reva/bots.json; presets seeded on first use.
import { readJson, writeJsonAtomic, exists } from '../util/fsx.js';

export const BOT_PRESETS = [
  {
    name: 'dots',
    description: 'Fast general-purpose worker bot (OpenAI models)',
    provider: 'openai',
    model: 'gpt-4o-mini',
    system: 'You are dots, a fast, pragmatic worker bot. Solve the task directly with minimal ceremony. Prefer action over explanation.',
    max_iterations: 16,
  },
  {
    name: 'grok',
    description: 'Bold analysis bot running xAI Grok models',
    provider: 'grok',
    model: 'grok-3-mini',
    system: 'You are grok, a sharp, irreverent analyst bot. Cut to the heart of the task, call out nonsense, and still deliver rigorous work.',
    max_iterations: 16,
  },
];

export class BotRegistry {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, bots: {} };
  }

  async load() {
    if (await exists(this.file)) {
      this.data = await readJson(this.file, this.data);
    }
    if (Object.keys(this.data.bots).length === 0) {
      for (const preset of BOT_PRESETS) {
        this.data.bots[preset.name] = { ...preset };
      }
      await this._persist();
    }
    return this;
  }

  async _persist() {
    await writeJsonAtomic(this.file, this.data);
  }

  list() {
    return Object.values(this.data.bots).map((b) => ({
      name: b.name,
      description: b.description,
      provider: b.provider,
      model: b.model,
      system: b.system,
      max_iterations: b.max_iterations,
      tools_allow: b.tools_allow ?? null,
    }));
  }

  get(name) {
    return this.data.bots[name] ?? null;
  }

  async upsert(bot) {
    validateBot(bot);
    this.data.bots[bot.name] = { ...this.get(bot.name), ...bot };
    await this._persist();
    return this.data.bots[bot.name];
  }

  async remove(name) {
    if (!this.data.bots[name]) return false;
    delete this.data.bots[name];
    await this._persist();
    return true;
  }
}

export function validateBot(bot) {
  if (!bot || typeof bot !== 'object') throw new Error('bot must be an object');
  if (typeof bot.name !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(bot.name)) {
    throw new Error('bot name must be 2-32 chars [a-z0-9_-]');
  }
  if (bot.provider !== undefined && typeof bot.provider !== 'string') throw new Error('provider must be a string');
  if (bot.model !== undefined && typeof bot.model !== 'string') throw new Error('model must be a string');
  if (bot.system !== undefined && (typeof bot.system !== 'string' || bot.system.length > 10000)) {
    throw new Error('system prompt must be a string up to 10KB');
  }
  if (bot.max_iterations !== undefined && (!Number.isInteger(bot.max_iterations) || bot.max_iterations < 1 || bot.max_iterations > 100)) {
    throw new Error('max_iterations must be an integer 1-100');
  }
  if (bot.tools_allow !== undefined && bot.tools_allow !== null) {
    if (!Array.isArray(bot.tools_allow) || bot.tools_allow.some((t) => typeof t !== 'string')) {
      throw new Error('tools_allow must be an array of tool names or null');
    }
  }
  return true;
}
