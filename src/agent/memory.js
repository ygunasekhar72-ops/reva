// Memory manager: per-project AI memory workspace (<project>/.reva/memory/)
// plus the snapshot-before-compaction pipeline. Before the conversation is
// compacted, the model is asked to distill it into durable notes (summary,
// decisions, facts, todos, gotchas) that are written to the memory workspace,
// so long projects keep their context across compactions and sessions.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fsx.js';
import { estimateMessagesTokens } from '../util/text.js';

export class MemoryManager {
  constructor({ workspace, config }) {
    this.workspace = workspace;
    this.config = config;
    this.dir = path.join(workspace, '.reva', 'memory');
  }

  async readAll() {
    if (!(await exists(this.dir))) return { topics: {}, index: '' };
    const out = { topics: {}, index: '' };
    for (const f of (await fsp.readdir(this.dir)).filter((x) => x.endsWith('.md'))) {
      const content = await fsp.readFile(path.join(this.dir, f), 'utf8');
      const topic = f.replace(/\.md$/, '');
      if (topic === 'INDEX') out.index = content;
      else out.topics[topic] = content;
    }
    return out;
  }

  async readTopic(topic) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(topic)) throw new Error('invalid topic');
    const file = path.join(this.dir, `${topic}.md`);
    if (!(await exists(file))) return null;
    return fsp.readFile(file, 'utf8');
  }

  async writeTopic(topic, content) {
    if (!/^[a-z0-9_-]{1,64}$/i.test(topic)) throw new Error('invalid topic');
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(path.join(this.dir, `${topic}.md`), content, 'utf8');
  }

  // System-prompt block: what the AI already remembers about this project.
  async promptSection({ maxChars = 6000 } = {}) {
    const mem = await this.readAll();
    const parts = [];
    for (const [topic, content] of Object.entries(mem.topics)) {
      parts.push(`### ${topic}\n${content.trim()}`);
    }
    if (parts.length === 0) return '';
    const body = parts.join('\n\n');
    const trimmed = body.length > maxChars ? `${body.slice(0, maxChars)}\n[...truncated — full memory in .reva/memory/, use memory_read]` : body;
    return `\n## Project memory (from previous sessions)\n${trimmed}\n`;
  }

  // Ask the model to distill the conversation into durable notes, write them
  // into the memory workspace, and return a compaction summary.
  async snapshotAndSummarize({ messages, chat, signal, emit }) {
    const conversation = messages
      .filter((m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
      .slice(-40)
      .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 4000)}`)
      .join('\n\n')
      .slice(0, 60000);

    emit?.({ type: 'compaction_phase', phase: 'memory_snapshot' });

    const prompt = [
      'You are the memory subsystem of an AI coding agent. The conversation below is about to be compacted.',
      'Distill everything that matters for future sessions into durable notes.',
      'Reply with ONLY a JSON object (no markdown fences) of shape:',
      '{"summary": "2-6 sentence status of the project and conversation",',
      ' "decisions": ["decision 1", ...], "facts": ["fact 1", ...],',
      ' "todos": ["open task 1", ...], "gotchas": ["pitfall 1", ...]}',
      '',
      'CONVERSATION:',
      conversation,
    ].join('\n');

    const response = await chat({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      signal,
    });
    const parsed = extractJson(response.text) ?? {};
    const notes = {
      decisions: asList(parsed.decisions),
      facts: asList(parsed.facts),
      todos: asList(parsed.todos),
      gotchas: asList(parsed.gotchas),
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    };

    // merge into topic files, newest first
    const stamp = new Date().toISOString().slice(0, 10);
    const merge = async (topic, items) => {
      if (items.length === 0) return;
      const existing = (await this.readTopic(topic)) ?? '';
      const fresh = items.map((i) => `- [${stamp}] ${i}`).join('\n');
      await this.writeTopic(topic, existing ? `${existing}\n${fresh}` : `# ${topic}\n${fresh}`);
    };
    await merge('decisions', notes.decisions);
    await merge('facts', notes.facts);
    await merge('todos', notes.todos);
    await merge('gotchas', notes.gotchas);

    emit?.({ type: 'memory_saved', topics: ['decisions', 'facts', 'todos', 'gotchas'].filter((t) => true), phase: 'compaction' });
    emit?.({ type: 'compaction_phase', phase: 'compact' });

    const summaryMessage = [
      '[CONVERSATION COMPACTED — earlier messages were summarized into project memory]',
      notes.summary,
      notes.decisions.length > 0 ? `\nDecisions:\n${notes.decisions.map((d) => `- ${d}`).join('\n')}` : '',
      notes.facts.length > 0 ? `\nKey facts:\n${notes.facts.map((d) => `- ${d}`).join('\n')}` : '',
      notes.todos.length > 0 ? `\nOpen todos:\n${notes.todos.map((d) => `- ${d}`).join('\n')}` : '',
      notes.gotchas.length > 0 ? `\nGotchas:\n${notes.gotchas.map((d) => `- ${d}`).join('\n')}` : '',
      '\nDurable notes were saved to .reva/memory/ and are available via memory_read.',
    ].filter(Boolean).join('\n');

    return { summaryMessage, notes };
  }

  shouldCompact(messages, threshold) {
    return estimateMessagesTokens(messages) > threshold;
  }
}

export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function asList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim().length > 0).slice(0, 50);
}
