# Extending REVA

REVA has four extension mechanisms. Pick by layer:

| You want to… | Use |
|---|---|
| give the agent a new capability that runs server-side | **Plugin** |
| add UI cards/commands to the mobile app | **Mobile extension** |
| connect an external tool server (yours or third-party) | **MCP server** |
| teach the agent a reusable *workflow* (no code) | **Skill** |

## Plugins (server-side)

Directory layout (any of: `<reva>/plugins/`, `~/.reva/plugins/`,
`<project>/.reva/plugins/`, `<project>/plugins/` — later dirs override):

```
my-plugin/
  plugin.json
  index.js
```

```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "What it does",
  "entry": "index.js",
  "permissions": ["tools", "events"]
}
```

```js
export function activate(ctx) {
  ctx.registerTool({
    name: 'deploy_check',
    description: 'Check deploy status',
    parameters: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
    async execute(args) {
      return { text: `deploy ${args.env}: green` };
    },
  });

  ctx.on('tool:before', (payload) => { /* observe/veto by throwing */ });
  ctx.on('tool:after',  (payload) => { /* results */ });
  ctx.on('message:new', (payload) => { /* every user message */ });
}
```

Rules enforced by the loader (`src/plugins/index.js`):

- tool names are namespaced: `plugin__my-plugin__deploy_check`;
- permissions: `tools`, `events`, `network`, `filesystem`, `shell` — the
  context throws if you use an API you didn't declare;
- `activate()` throwing, or any hook throwing, marks the plugin failed /
  isolates the error — a broken plugin can never take the harness down;
- the entry file cannot escape its own directory.

The bundled `plugins/sample` demonstrates all of it (word-count tool + hooks).

## Mobile extensions (PWA)

```
my-extension/
  extension.json
  index.js
```

```json
{
  "name": "my-extension",
  "version": "1.0.0",
  "description": "Card + command demo",
  "entry": "index.js",
  "permissions": ["ui.cards", "ui.commands", "network"]
}
```

The entry file is served at `/extensions/<name>` — a registry-keyed URL. The
request never carries a filename; the server resolves the entry from the
manifest at load time, so no request-supplied path ever reaches the
filesystem. Keep extensions to one self-contained file (import-free is the
supported shape today).

```js
export function activate(reva) {
  reva.registerCard({
    title: 'Build status',
    render(el) { el.innerHTML = '…'; },          // DOM element for your card
  });
  reva.addCommand({
    name: 'refresh',
    label: 'refresh status',
    async run(api) {                              // api.fetch wraps the authed API
      const data = await api.fetch('/api/tools');
      api.notify(`tools: ${data.tools.length}`);
    },
  });
}
```

Permissions: `ui.cards`, `ui.commands`, `ui.widgets`, `network`, `storage`.
The server lists extensions at `GET /api/extensions` and serves their files
**only** from inside their own directory (path-guarded, traversal returns 404).
The PWA dynamically imports each extension and hands it the registration API
(`public/app.js` → `EXTENSION_API`). Extensions run in the browser sandbox;
they get no Node, no filesystem, and only the explicitly-exposed API surface.

Bundled example: `extensions/system-status` (device/connection card + a
"list agent tools" command).

## MCP servers

In `.reva/config.json`:

```json
{ "mcp": { "servers": {
  "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "disabled-one": { "command": "node", "args": ["server.js"], "enabled": false }
} } }
```

`reva mcp connect` (or the PWA button) starts each server, performs the MCP
initialize handshake, pulls `tools/list`, and exposes every tool to the agent
as `mcp__<server>__<tool>`. Requests time out (`mcp.call_timeout_ms`), crashes
surface as clean errors, and a server that dies mid-request rejects that
request deterministically.

## Skills

```
.reva/skills/release-checklist/SKILL.md
```

```markdown
---
name: release-checklist
description: Verify a release end to end before tagging.
version: 1.0.0
when-to-use: When the user asks to cut, tag, or verify a release.
---

1. Run the full test suite and report failures…
```

The name + when-to-use go into the agent's system prompt; the agent loads the
full body with the `skill` tool when a task matches. Skills are data, not
code — nothing executes beyond the agent's own tools.
