// Filesystem tools: read, write, edit, list (glob), grep. Every path passes
// through the path guard and resolves inside the workspace.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { guardPath, toRelative } from '../security/pathguard.js';
import { truncate } from '../util/text.js';

const MAX_READ_BYTES = 512 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;

async function resolveIn(ctx, p, opts) {
  return guardPath(ctx.workspace, p, opts);
}

// ---- read -----------------------------------------------------------------

export const readTool = {
  name: 'read',
  description: 'Read a text file from the workspace. Returns the content with line numbers. Fails if the file is missing or outside the workspace.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      offset: { type: 'number', description: '1-based line to start from' },
      limit: { type: 'number', description: 'Max lines to return' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const real = await resolveIn(ctx, args.path, { allowMissing: false });
    const stat = await fsp.stat(real);
    if (stat.size > MAX_READ_BYTES) {
      throw new Error(`file too large to read (${stat.size} bytes, max ${MAX_READ_BYTES})`);
    }
    const text = await fsp.readFile(real, 'utf8');
    const lines = text.split('\n');
    const start = Math.max(1, args.offset ?? 1);
    const end = Math.min(lines.length, start - 1 + (args.limit ?? 2000));
    const slice = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(4)}  ${l}`).join('\n');
    return {
      text: slice || '(empty file)',
      total_lines: lines.length,
      path: await toRelative(ctx.workspace, real),
    };
  },
};

// ---- write ----------------------------------------------------------------

export const writeTool = {
  name: 'write',
  description: 'Create or overwrite a file in the workspace with the given content. Parent directories are created automatically.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
  dangerous: true,
  async execute(args, ctx) {
    const real = await resolveIn(ctx, args.path);
    const content = String(args.content ?? '');
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
      throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    }
    await fsp.mkdir(path.dirname(real), { recursive: true });
    await fsp.writeFile(real, content, 'utf8');
    return {
      text: `wrote ${content.split('\n').length} lines to ${await toRelative(ctx.workspace, real)}`,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  },
};

// ---- edit -----------------------------------------------------------------

// Exact string replacement. The model must echo the old text precisely, which
// keeps edits reviewable and prevents accidental mass rewrites.
export const editTool = {
  name: 'edit',
  description: 'Replace an exact string in a file. old_string must match exactly and uniquely (or provide replace_all=true).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative file path' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  dangerous: true,
  async execute(args, ctx) {
    const real = await resolveIn(ctx, args.path, { allowMissing: false });
    const text = await fsp.readFile(real, 'utf8');
    const oldStr = String(args.old_string);
    if (oldStr.length === 0) throw new Error('old_string must not be empty');
    const newStr = String(args.new_string ?? '');
    const count = text.split(oldStr).length - 1;
    if (count === 0) {
      throw new Error(`old_string not found in ${args.path}. Read the file and copy the exact text.`);
    }
    if (count > 1 && args.replace_all !== true) {
      throw new Error(`old_string matches ${count} times; pass replace_all=true or include more context to make it unique`);
    }
    const next = args.replace_all === true
      ? text.split(oldStr).join(newStr)
      : text.replace(oldStr, newStr);
    await fsp.writeFile(real, next, 'utf8');
    return { text: `edited ${await toRelative(ctx.workspace, real)} (${count} replacement${count === 1 ? '' : 's'})` };
  },
};

// ---- list (glob-ish) ------------------------------------------------------

export const listTool = {
  name: 'list',
  description: 'List files and directories under a workspace directory (recursive). Skip-lists node_modules, .git and build dirs. Use pattern to filter by substring or *.ext glob.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative directory (default ".")' },
      pattern: { type: 'string', description: 'Optional filter: substring or *.ext glob' },
      max_entries: { type: 'number', description: 'Max entries (default 400)' },
    },
  },
  async execute(args, ctx) {
    const real = await resolveIn(ctx, args.path ?? '.', { allowMissing: false });
    const max = Math.min(2000, args.max_entries ?? 400);
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'vendor']);
    const out = [];
    const pattern = args.pattern ? String(args.pattern) : null;

    const match = (name) => {
      if (!pattern) return true;
      if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
      return name.toLowerCase().includes(pattern.toLowerCase());
    };

    async function walk(dir, depth) {
      if (out.length >= max || depth > 10) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const entry of entries) {
        if (out.length >= max) return;
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const rel = await toRelative(ctx.workspace, full);
        if (entry.isDirectory()) {
          out.push({ path: rel, type: 'dir' });
          await walk(full, depth + 1);
        } else if (match(entry.name)) {
          let size = 0;
          try { size = (await fsp.stat(full)).size; } catch { /* raced */ }
          out.push({ path: rel, type: 'file', size });
        }
      }
    }

    await walk(real, 0);
    const files = out.filter((e) => e.type === 'file');
    return {
      text: out.map((e) => (e.type === 'dir' ? `${e.path}/` : `${e.path} (${e.size}b)`)).join('\n') || '(empty)',
      count: files.length,
      entries: out.slice(0, 500),
    };
  },
};

// ---- grep -----------------------------------------------------------------

export const grepTool = {
  name: 'grep',
  description: 'Search file contents with a regular expression. Returns matching lines with file:line references. Skips binaries and heavy directories.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript-style regex' },
      path: { type: 'string', description: 'Workspace-relative directory to search (default ".")' },
      glob: { type: 'string', description: 'File extension filter like "*.js"' },
      max_results: { type: 'number', description: 'Max matches (default 100)' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    let regex;
    try {
      regex = new RegExp(args.pattern, 'i');
    } catch (err) {
      throw new Error(`invalid regex: ${err.message}`);
    }
    const root = await resolveIn(ctx, args.path ?? '.', { allowMissing: false });
    const max = Math.min(500, args.max_results ?? 100);
    const extFilter = args.glob && args.glob.startsWith('*.') ? args.glob.slice(1) : null;
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'vendor']);
    const results = [];

    async function walk(dir, depth) {
      if (results.length >= max || depth > 12) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= max) return;
        if (SKIP.has(entry.name)) continue;
        // Containment: every walked path must stay inside the guarded root.
        const base = path.resolve(dir);
        const full = path.resolve(base, entry.name);
        if (full !== base && !full.startsWith(base + path.sep)) continue;
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (extFilter && !entry.name.endsWith(extFilter)) continue;
        let stat;
        try { stat = await fsp.stat(full); } catch { continue; }
        if (stat.size > 1024 * 1024) continue;
        let text;
        try { text = await fsp.readFile(full, 'utf8'); } catch { continue; } // binary/encoding
        // crude binary check
        if (text.includes('\0')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && results.length < max; i++) {
          if (regex.test(lines[i])) {
            results.push({
              file: await toRelative(ctx.workspace, full),
              line: i + 1,
              text: truncate(lines[i].trim(), 240),
            });
          }
        }
      }
    }

    await walk(root, 0);
    return {
      text: results.map((r) => `${r.file}:${r.line}: ${r.text}`).join('\n') || '(no matches)',
      count: results.length,
      matches: results,
    };
  },
};
