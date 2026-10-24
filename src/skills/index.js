// Skills: markdown packages (SKILL.md with frontmatter) that teach the agent
// reusable workflows. Loaded from (highest priority last):
//   built-in <reva>/skills/  <  global ~/.reva/skills/  <  <project>/.reva/skills/
import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists } from '../util/fsx.js';
import { parseFrontmatter } from '../util/text.js';

export class SkillRegistry {
  constructor({ builtinDir, globalDir, projectDirs = [] } = {}) {
    this.dirs = [builtinDir, globalDir, ...projectDirs].filter(Boolean);
    this.skills = new Map();
  }

  async load() {
    this.skills.clear();
    for (const dir of this.dirs) {
      if (!(await exists(dir))) continue;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = path.join(dir, entry.name);
        const file = path.join(skillDir, 'SKILL.md');
        if (!(await exists(file))) continue;
        try {
          const raw = await fsp.readFile(file, 'utf8');
          const { data, body } = parseFrontmatter(raw);
          const name = String(data.name ?? entry.name);
          if (!/^[a-z0-9_-]{2,64}$/i.test(name)) {
            throw new Error(`invalid skill name "${name}"`);
          }
          const skill = {
            name,
            dir: skillDir,
            description: String(data.description ?? ''),
            'when-to-use': String(data['when-to-use'] ?? data.when_to_use ?? data.description ?? ''),
            'allowed-tools': data['allowed-tools'] ?? data.allowed_tools ?? null,
            version: String(data.version ?? '0.0.0'),
            body: body.trim(),
            source: dir,
          };
          this.skills.set(name, skill); // later dirs override earlier
        } catch (err) {
          this.skills.set(`__error:${entry.name}`, { name: `__error:${entry.name}`, error: err.message, dir: skillDir });
        }
      }
    }
    return this.list();
  }

  list() {
    return [...this.skills.values()].filter((s) => !s.name.startsWith('__error:'));
  }

  errors() {
    return [...this.skills.values()].filter((s) => s.name.startsWith('__error:'));
  }

  get(name) {
    return this.skills.get(name) ?? null;
  }

  // Compact catalog injected into the system prompt: name + when-to-use only,
  // so the model knows skills exist and asks for the body via the skill tool.
  toPromptSection() {
    const skills = this.list();
    if (skills.length === 0) return '';
    const lines = skills.map((s) => `- ${s.name}: ${s['when-to-use'] || s.description}`);
    return [
      '## Skills',
      'The following skills are installed. When a task matches one, call the `skill` tool with its name to load its full instructions before proceeding.',
      ...lines,
    ].join('\n');
  }
}
