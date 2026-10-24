// Leveled logger. Never logs secrets — every string passes through redact().
import { redact } from '../security/redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let current = 'info';
let sink = (line) => console.error(line);

export const log = {
  setLevel(level) {
    if (!(level in LEVELS)) throw new Error(`unknown log level: ${level}`);
    current = level;
  },
  get level() { return current; },
  setSink(fn) { sink = fn; },
  _emit(level, args) {
    if (LEVELS[level] < LEVELS[current]) return;
    const line = args.map((a) => (typeof a === 'string' ? redact(a) : redact.json(a))).join(' ');
    sink(`[${level}] ${line}`);
  },
  debug: (...a) => log._emit('debug', a),
  info: (...a) => log._emit('info', a),
  warn: (...a) => log._emit('warn', a),
  error: (...a) => log._emit('error', a),
};
