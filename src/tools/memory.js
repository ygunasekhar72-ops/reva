// skill tool: loads a skill's full body into the conversation.
// memory tools: per-project persistent memory workspace at <project>/.reva/memory/
// todo tool: structured plan tracking (part of the visible working process).
import fsp from 'node:fs/promises';
import path from 'node:path';
import { guardPath } from '../security/pathguard.js';
import { exists } from '../util/fsx.js';

export const skillTool = {
  name: 'skill',
  description: 'Load the full instructions of an installed skill by name. Use when the task matches a skill listed in your system prompt.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name from the skills catalog' },
    },
    required: ['name'],
  },
  async execute(args, ctx) {
    const registry = ctx.skillRegistry;
    if (!registry) throw new Error('skills not available in this session');
    const skill = registry.get(String(args.name ?? ''));
    if (!skill) {
      const names = registry.list().map((s) => s.name).join(', ') || '(none installed)';
      throw new Error(`skill "${args.name}" not found. Installed: ${names}`);
    }
    return {
      text: `# Skill: ${skill.name}\n\n${skill.body}`,
      skill: skill.name,
    };
  },
};

// ---- memory ----------------------------------------------------------------

export function memoryDirFor(workspace) {
  return path.join(workspace, '.reva', 'memory');
}

const TOPIC_RE = /^[a-z0-9_-]{1,64}$/i;

export const memorySaveTool = {
  name: 'memory_save',
  description: 'Persist a durable note to this project\'s memory workspace (.reva/memory/). Use for decisions, facts, gotchas, and open todos that must survive compaction and future sessions.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Topic slug, e.g. "decisions", "gotchas", "api-design"' },
      content: { type: 'string', description: 'The note (markdown). Will be appended under a dated heading.' },
    },
    required: ['topic', 'content'],
  },
  async execute(args, ctx) {
    const topic = String(args.topic ?? '').trim();
    if (!TOPIC_RE.test(topic)) throw new Error('topic must be 1-64 chars: letters, digits, - _');
    const content = String(args.content ?? '').trim();
    if (content.length === 0) throw new Error('content must not be empty');
    if (content.length > 100000) throw new Error('note too large (100KB max)');

    const dir = memoryDirFor(ctx.workspace);
    const real = await guardPath(dir, `${topic}.md`, { allowMissing: true });
    await fsp.mkdir(path.dirname(real), { recursive: true });
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    const entry = `\n## ${stamp}\n${content}\n`;
    let existing = '';
    if (await exists(real)) existing = await fsp.readFile(real, 'utf8');
    await fsp.writeFile(real, existing + entry, 'utf8');
    await indexMemory(dir, topic);
    ctx.emit?.({ type: 'memory_saved', topic });
    return { text: `saved memory to ${topic}.md (${content.length} chars)` };
  },
};

export const memoryReadTool = {
  name: 'memory_read',
  description: 'Read memory notes for this project. With no topic, returns the memory index (all topics and sizes).',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Optional topic slug to read fully' },
    },
  },
  async execute(args, ctx) {
    const dir = memoryDirFor(ctx.workspace);
    if (!(await exists(dir))) return { text: '(no memory yet for this project)' };
    if (args.topic) {
      const topic = String(args.topic).trim();
      if (!TOPIC_RE.test(topic)) throw new Error('invalid topic');
      const real = await guardPath(dir, `${topic}.md`, { allowMissing: false });
      return { text: await fsp.readFile(real, 'utf8') };
    }
    const entries = await fsp.readdir(dir);
    const lines = [];
    for (const f of entries.filter((e) => e.endsWith('.md'))) {
      const stat = await fsp.stat(path.join(dir, f));
      lines.push(`${f.replace(/\.md$/, '')} (${stat.size} bytes)`);
    }
    return { text: lines.length > 0 ? lines.join('\n') : '(memory empty)' };
  },
};

async function indexMemory(dir, topic) {
  const indexFile = path.join(dir, 'INDEX.md');
  let index = '';
  if (await exists(indexFile)) index = await fsp.readFile(indexFile, 'utf8');
  const line = `- ${topic}`;
  if (!index.split('\n').includes(line)) {
    await fsp.writeFile(indexFile, `${index}${index.endsWith('\n') || index === '' ? '' : '\n'}${line}\n`, 'utf8');
  }
}

// ---- todo ------------------------------------------------------------------

export const todoTool = {
  name: 'todo',
  description: 'Track your working plan for the current task. Call with items=[{content, status}] replacing the full list; status is pending|in_progress|completed. Always call before starting multi-step work and as you progress.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Full todo list (replaces previous)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['items'],
  },
  async execute(args, ctx) {
    const items = (args.items ?? []).slice(0, 100).map((i) => ({
      content: String(i.content ?? '').slice(0, 500),
      status: ['pending', 'in_progress', 'completed'].includes(i.status) ? i.status : 'pending',
    }));
    ctx.session?.setState?.('todos', items);
    ctx.emit?.({ type: 'todos', items });
    const done = items.filter((i) => i.status === 'completed').length;
    return { text: `todo list updated: ${done}/${items.length} completed`, items };
  },
};
