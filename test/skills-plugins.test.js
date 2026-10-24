// Skills, plugins, and extensions registry tests — including the real built-in
// sample plugin, permission enforcement, and fault isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isolateHome, makeWorkspace, cleanupDir } from '../testkit/env.js';
isolateHome(test);

import { SkillRegistry } from '../src/skills/index.js';
import { PluginRegistry, PLUGIN_PERMISSIONS } from '../src/plugins/index.js';
import { ExtensionRegistry, EXTENSION_PERMISSIONS } from '../src/extensions/index.js';
import { parseFrontmatter } from '../src/util/text.js';

const APP = process.cwd();

async function writeFile(p, content) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
}

// ---------- skills ----------

test('skills: built-in commit skill is discovered and parsed', async () => {
  const reg = new SkillRegistry({ builtinDir: path.join(APP, 'skills') });
  await reg.load();
  const skill = reg.get('commit');
  assert.ok(skill, 'commit skill must exist');
  assert.match(skill.description, /git commit/);
  assert.match(skill.body, /heredoc/);
  assert.ok(reg.toPromptSection().includes('- commit:'));
});

test('skills: project dir overrides built-in, errors isolated per skill', async () => {
  const project = await makeWorkspace('skills');
  await writeFile(path.join(project, '.reva', 'skills', 'commit', 'SKILL.md'),
    '---\nname: commit\ndescription: project override\n---\nProject-specific commit flow.');
  await writeFile(path.join(project, '.reva', 'skills', 'explorer', 'SKILL.md'),
    '---\nname: explorer\ndescription: read-only exploration\n---\nExplore safely.');
  await writeFile(path.join(project, '.reva', 'skills', 'broken', 'SKILL.md'),
    '---\nname: "BAD NAME!!"\ndescription: x\n---\nbody');

  const reg = new SkillRegistry({ builtinDir: path.join(APP, 'skills'), projectDirs: [path.join(project, '.reva', 'skills')] });
  await reg.load();
  assert.match(reg.get('commit').description, /project override/);
  assert.ok(reg.get('explorer'));
  const errors = reg.errors();
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /invalid skill name/);
  assert.equal(reg.list().some((s) => s.name === 'broken'), false, 'broken skills are not listed');
  await cleanupDir(project);
});

test('frontmatter parser: scalars, lists, no-frontmatter bodies', () => {
  const { data, body } = parseFrontmatter('---\nname: x\ntags: a, b\nnums: 5\nflag: true\nitems:\n  - one\n  - two\n---\nBODY');
  assert.deepEqual(data, { name: 'x', tags: 'a, b', nums: 5, flag: true, items: ['one', 'two'] });
  assert.equal(body, 'BODY');
  const plain = parseFrontmatter('just text');
  assert.deepEqual(plain.data, {});
  assert.equal(plain.body, 'just text');
});

// ---------- plugins ----------

test('plugins: built-in sample plugin activates, registers tool + hooks', async () => {
  const reg = new PluginRegistry({ builtinDir: path.join(APP, 'plugins') });
  await reg.load();
  const sample = reg.get('sample');
  assert.ok(sample);
  assert.equal(sample.status, 'active');
  assert.ok(sample.registeredTools.includes('plugin__sample__word_count'));

  // the registered tool is callable through the registry surface
  const toolDef = reg.toolDefs().find((t) => t.name === 'plugin__sample__word_count');
  assert.ok(toolDef);
  const result = await toolDef.execute({ text: 'one two three four' });
  assert.equal(result.text, 'words=4 lines=1 chars=18');

  // hooks fire
  const results = await reg.emit('message:new', { session: 's1', text: 'hello' });
  assert.equal(results.length, 1);
  assert.equal(results[0].plugin, 'sample');
  assert.equal(results[0].error, undefined);
});

test('plugins: permissions are enforced', async () => {
  const reg = new PluginRegistry({});
  // no "tools" permission → registerTool throws inside activate → plugin fails
  const ctx = reg._makeContext({ name: 'no-perm', permissions: ['events'], registeredTools: [] });
  assert.throws(() => ctx.registerTool({ name: 'x', execute: () => {} }), /lacks "tools" permission/);
  const ctx2 = reg._makeContext({ name: 'no-events', permissions: ['tools'], registeredTools: [] });
  assert.throws(() => ctx2.on('message:new', () => {}), /lacks "events" permission/);
  assert.deepEqual(PLUGIN_PERMISSIONS, ['tools', 'events', 'network', 'filesystem', 'shell']);
});

test('plugins: broken plugin cannot take the harness down', async () => {
  const dir = await makeWorkspace('plugins-broken');
  await writeFile(path.join(dir, 'p1', 'plugin.json'), JSON.stringify({ name: 'throws', entry: 'index.js', permissions: [] }));
  await writeFile(path.join(dir, 'p1', 'index.js'), 'export function activate() { throw new Error("plugin blew up"); }');
  await writeFile(path.join(dir, 'p2', 'plugin.json'), JSON.stringify({ name: 'bad-entry', entry: '../escape.js', permissions: [] }));
  await writeFile(path.join(dir, 'p2', 'index.js'), 'export function activate() {}');
  await writeFile(path.join(dir, 'notaplugin', 'readme.txt'), 'no manifest here');

  const reg = new PluginRegistry({ projectDirs: [dir] });
  await reg.load();
  const throwsPlugin = reg.get('throws');
  assert.equal(throwsPlugin.status, 'failed');
  assert.match(throwsPlugin.error, /plugin blew up/);
  const badEntry = reg.get('bad-entry');
  assert.equal(badEntry.status, 'failed');
  assert.equal(reg.get('notaplugin'), null, 'dirs without manifests are ignored');
  await cleanupDir(dir);
});

test('plugins: context factory registers namespaced tools into registry list', async () => {
  const dir = await makeWorkspace('plugins-ok');
  await writeFile(path.join(dir, 'myplug', 'plugin.json'), JSON.stringify({
    name: 'myplug', entry: 'index.js', permissions: ['tools', 'events'],
  }));
  await writeFile(path.join(dir, 'myplug', 'index.js'), `
    export function activate(ctx) {
      ctx.registerTool({
        name: 'greet',
        description: 'greets',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        async execute(args) { return { text: 'hi ' + args.name }; },
      });
      ctx.on('tool:before', () => 'observed');
    }`);

  const reg = new PluginRegistry({ projectDirs: [dir] });
  await reg.load();
  assert.equal(reg.get('myplug').status, 'active');
  const defs = reg.toolDefs();
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'plugin__myplug__greet');
  const out = await reg.emit('tool:before', { tool: 'read' });
  assert.deepEqual(out, [{ plugin: 'myplug', result: 'observed' }]);
  // hook errors are isolated (fresh dir: ESM caches modules per URL)
  await writeFile(path.join(dir, 'hookbug', 'plugin.json'), JSON.stringify({
    name: 'hookbug', entry: 'index.js', permissions: ['events'],
  }));
  await writeFile(path.join(dir, 'hookbug', 'index.js'), `
    export function activate(ctx) {
      ctx.on('tool:before', () => { throw new Error('hook bug'); });
    }`);
  await reg.load();
  const res = await reg.emit('tool:before', {});
  const hookbug = res.find((r) => r.plugin === 'hookbug');
  assert.ok(hookbug);
  assert.match(hookbug.error, /hook bug/);
  await cleanupDir(dir);
});

// ---------- extensions ----------

test('extensions: built-in system-status extension listed with URL + permissions', async () => {
  const reg = new ExtensionRegistry({ builtinDir: path.join(APP, 'extensions') });
  await reg.load();
  const ext = reg.get('system-status');
  assert.ok(ext);
  assert.equal(ext.valid, true);
  assert.deepEqual(ext.permissions, ['ui.cards', 'ui.commands', 'network']);
  const listed = reg.list()[0];
  assert.equal(listed.url, '/extensions/system-status');
});

test('extensions: entry resolution is registry-keyed — no request path reaches fs', async () => {
  const reg = new ExtensionRegistry({ builtinDir: path.join(APP, 'extensions') });
  await reg.load();
  const entry = await reg.resolveEntry('system-status');
  assert.ok(entry);
  assert.match(entry.abs, /system-status/);
  assert.match(entry.abs, /index\.js$/);
  assert.equal(await reg.resolveEntry('ghost-ext'), null);
  assert.equal(await reg.resolveEntry(''), null);
  assert.equal(await reg.resolveEntry(undefined), null);
  assert.deepEqual(EXTENSION_PERMISSIONS, ['ui.cards', 'ui.commands', 'ui.widgets', 'network', 'storage']);
});

test('extensions: invalid manifests are flagged not served', async () => {
  const dir = await makeWorkspace('ext-bad');
  await writeFile(path.join(dir, 'badperm', 'extension.json'), JSON.stringify({
    name: 'badperm', entry: 'index.js', permissions: ['root-access'],
  }));
  const reg = new ExtensionRegistry({ projectDirs: [dir] });
  await reg.load();
  assert.equal(reg.get('badperm').valid, false);
  assert.equal(reg.list().find((e) => e.name === 'badperm').valid, false);
  await cleanupDir(dir);
});
