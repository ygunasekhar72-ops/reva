// Automation engine: persisted scheduled jobs that run bots (or one-shot agent
// prompts) on an interval or daily-at-time schedule. Jobs live in
// <project>/.reva/automation.json; the scheduler runs while `reva serve`, the
// TUI, or `reva auto daemon` is alive.
import { readJson, writeJsonAtomic, exists } from '../util/fsx.js';
import { newId } from '../util/ids.js';

export class AutomationStore {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, jobs: {} };
  }

  async load() {
    if (await exists(this.file)) {
      this.data = await readJson(this.file, this.data);
    }
    return this;
  }

  async _persist() {
    await writeJsonAtomic(this.file, this.data);
  }

  list() {
    return Object.values(this.data.jobs).sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
  }

  get(id) {
    return this.data.jobs[id] ?? null;
  }

  async add(job) {
    validateJob(job);
    const id = newId('job');
    const record = {
      id,
      name: job.name,
      bot: job.bot ?? null,
      prompt: job.prompt,
      schedule: job.schedule, // {every_ms} | {daily_at: "HH:MM"}
      enabled: job.enabled !== false,
      created_at: Date.now(),
      last_run: null,
      last_status: null,
      last_error: null,
      run_count: 0,
    };
    this.data.jobs[id] = record;
    await this._persist();
    return record;
  }

  async update(id, patch) {
    const job = this.data.jobs[id];
    if (!job) return null;
    Object.assign(job, patch);
    await this._persist();
    return job;
  }

  async remove(id) {
    if (!this.data.jobs[id]) return false;
    delete this.data.jobs[id];
    await this._persist();
    return true;
  }

  dueJobs(now = Date.now()) {
    return this.list().filter((job) => {
      if (!job.enabled) return false;
      if (!job.last_run) return true;
      if (job.schedule.every_ms) return now - job.last_run >= job.schedule.every_ms;
      if (job.schedule.daily_at) {
        return now - job.last_run >= msUntilDaily(job.schedule.daily_at, job.last_run);
      }
      return false;
    });
  }
}

export function validateJob(job) {
  if (!job || typeof job !== 'object') throw new Error('job must be an object');
  if (typeof job.name !== 'string' || job.name.trim().length < 1) throw new Error('job.name required');
  if (typeof job.prompt !== 'string' || job.prompt.trim().length < 1) throw new Error('job.prompt required');
  if (job.prompt.length > 100000) throw new Error('job.prompt too large');
  const s = job.schedule;
  if (!s || typeof s !== 'object') throw new Error('job.schedule required');
  if (s.every_ms !== undefined) {
    if (!Number.isInteger(s.every_ms) || s.every_ms < 60000) {
      throw new Error('schedule.every_ms must be an integer >= 60000 (1 minute minimum)');
    }
  } else if (s.daily_at !== undefined) {
    if (typeof s.daily_at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.daily_at)) {
      throw new Error('schedule.daily_at must be HH:MM (24h)');
    }
  } else {
    throw new Error('schedule must include every_ms or daily_at');
  }
  if (job.bot !== null && job.bot !== undefined && typeof job.bot !== 'string') {
    throw new Error('job.bot must be a bot name or null');
  }
  return true;
}

export function msUntilDaily(hhmm, from = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number);
  const next = new Date(from);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime() - from;
}

// The runner: ticks every 30s, executes due jobs, records status.
export class Scheduler {
  constructor({ store, runJob, onEvent, tickMs = 30000 }) {
    this.store = store;
    this.runJob = runJob; // async (job) => void
    this.onEvent = onEvent;
    this.tickMs = tickMs;
    this.timer = null;
    this.running = new Set();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    const due = this.store.dueJobs();
    for (const job of due) {
      if (this.running.has(job.id)) continue;
      this.running.add(job.id);
      (async () => {
        try {
          this.onEvent?.({ type: 'automation_start', job: job.id, name: job.name });
          await this.runJob(job);
          await this.store.update(job.id, {
            last_run: Date.now(),
            last_status: 'ok',
            last_error: null,
            run_count: (job.run_count ?? 0) + 1,
          });
          this.onEvent?.({ type: 'automation_done', job: job.id, name: job.name });
        } catch (err) {
          await this.store.update(job.id, {
            last_run: Date.now(),
            last_status: 'error',
            last_error: String(err.message ?? err).slice(0, 500),
            run_count: (job.run_count ?? 0) + 1,
          }).catch(() => {});
          this.onEvent?.({ type: 'automation_error', job: job.id, name: job.name, error: String(err.message ?? err) });
        } finally {
          this.running.delete(job.id);
        }
      })();
    }
  }
}
