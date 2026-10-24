# REVA

**A zero-dependency AI agent harness. Terminal TUI + installable mobile app. Black & white, nothing wasted.**

REVA runs an AI agent directly inside your project: it thinks visibly, uses tools
(read/write/exec/web/MCP/skills), spawns subagents, remembers per-project context across
compactions, and exposes everything through both a terminal UI and a hardened HTTP API +
mobile PWA.

```
█▀▄ ▄▀▄ █▀▀ █   █▀█ ▄▀█
█▄▀ █▀█ ██▄ █▄▄ █▀▄ █▀█
```

- **Zero npm dependencies.** Pure Node.js (≥18.17) stdlib — no supply chain, no build step.
  Clone and run. Works on Windows, macOS, Linux, and **Android via Termux**.
- **Two frontends, one agent.** An inline-streaming TUI (opencode-style) and a mobile-first
  PWA you install from the browser ("Add to Home Screen") — no app store needed.
- **Security as a feature.** scrypt passwords, AES-256-GCM key storage, path/SSRF/command
  guards, rate limits, hash-chained audit log, adversarial test suite.

---

## Quick start

```bash
node bin/reva.js            # TUI (default command)
node bin/reva.js serve      # HTTP API + mobile PWA on http://127.0.0.1:7463
node bin/reva.js run "fix the failing tests" --json   # one-shot, automation-friendly
node bin/reva.js doctor     # environment + integrity check
node --test                 # run the full test suite (200+ tests)
```

### Connect a model

REVA talks to any of these with **your own API keys**:

| Provider | Kind | Env var |
|---|---|---|
| OpenAI | openai | `OPENAI_API_KEY` |
| Anthropic | anthropic | `ANTHROPIC_API_KEY` |
| Google Gemini | gemini | `GEMINI_API_KEY` |
| xAI Grok | openai-compatible | `XAI_API_KEY` |
| DeepSeek | openai-compatible | `DEEPSEEK_API_KEY` |
| OpenRouter | openai-compatible | `OPENROUTER_API_KEY` |
| Anything else (Ollama, LM Studio, vLLM…) | openai-compatible | set `base_url` in config |

Keys can come from the environment **or** the encrypted keystore:

```bash
node bin/reva.js auth init                 # admin account + encrypted keystore
node bin/reva.js auth key openai sk-...    # stored AES-256-GCM encrypted
node bin/reva.js auth status
```

Or per-project `.reva/config.json`:

```json
{
  "providers": { "openai": { "kind": "openai", "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini" } },
  "default_provider": "openai",
  "default_model": "gpt-4o-mini"
}
```

---

## The mobile app (Android)

```bash
node bin/reva.js serve --host 0.0.0.0 --port 7463
```

1. Open `http://<your-computer-ip>:7463` in Chrome on your phone (same network).
2. Log in (create the admin on first run — that password also encrypts your API keys).
3. Menu → **Add to Home Screen**. REVA now runs full-screen, standalone, with an offline
   app shell (service worker). This **is** the app — real PWA, installable, no store.

For a native APK wrapper, point Capacitor at the same server URL; no code changes needed.

**Termux (terminal on Android):** install Node.js in Termux, copy the `reva/` folder, and run
`node bin/reva.js` — the TUI works over Termux because the UI uses plain inline streaming
(no alternate-screen tricks).

---

## What's inside

| System | Where | What it does |
|---|---|---|
| Agent loop | `src/agent/agent.js` | streaming provider calls → tool rounds → subagents, with a visible thinking process |
| Memory before compaction | `src/agent/memory.js` | when context grows, the model first distills decisions/facts/todos/gotchas into `<project>/.reva/memory/`, then the conversation is compacted. Every project gets its own memory workspace |
| Subagents & multi-agent | `task` tool | bounded concurrent fan-out (`agent.max_concurrent_subagents`), read-only `explore` mode, depth guards |
| Tools | `src/tools/` | exec, read, write, edit, list, grep, web_search, web_fetch, skill, memory_save/read, todo, task |
| MCP | `src/mcp/client.js` | real MCP stdio client (JSON-RPC 2.0): initialize → tools/list → tools/call, timeouts, crash handling |
| Skills | `skills/` + `src/skills/` | markdown SKILL.md packages with frontmatter; catalog injected into the system prompt |
| Plugins (server) | `plugins/` + `src/plugins/` | JS modules with a manifest; register tools + lifecycle hooks; permission-gated, crash-isolated |
| Extensions (mobile) | `extensions/` | browser-side modules for the PWA (cards/commands), permission-declared, path-guarded serving |
| Bots | `src/bots/` | named presets on your keys — `dots` (OpenAI) and `grok` (xAI) ship built-in; add your own |
| Automation | `src/bots/automation.js` | scheduled jobs (interval or daily-at-HH:MM) run bots or one-shot prompts; runs under `serve`, the TUI host, or `reva auto daemon` |
| Login system | `src/security/` | scrypt account store, brute-force lockout, bearer sessions (SHA-256 at rest, sliding TTL) |
| Server | `src/server/index.js` | REST API + SSE event streaming + static PWA host; strict CSP, rate limits, body caps |
| TUI | `src/tui/index.js` | inline streaming, dim thinking panel, tool cards, slash commands, spinner, Ctrl+C interrupt |

Everything the agent does becomes an **event** (`src/agent/events.js`) — persisted as JSONL
per session and streamed live to whichever UI you're using. That's the visible thinking
process: thinking deltas, tool cards with timings, compaction notices, subagent activity.

## Session lifecycle

```bash
node bin/reva.js sessions list
node bin/reva.js sessions show ses_xxx
```

- Sessions persist in `<project>/.reva/sessions/` (JSONL + index) and **resume** across restarts.
- Compaction triggers on an estimated-token threshold; the memory snapshot runs first.
- `/resume <id>` in the TUI, or click a session in the PWA.

## Bots

```bash
node bin/reva.js bot list
node bin/reva.js bot run dots "summarize the git diff"
node bin/reva.js bot add mybot --provider gemini --model gemini-2.0-flash --system "You are…"
node bin/reva.js auto add nightly "run the test suite and summarize failures" --daily-at 23:30 --bot dots
node bin/reva.js auto daemon
```

In the PWA: **Bots** tab → pick a bot → run. **More → automation** → add scheduled jobs.

## MCP

```json
{ "mcp": { "servers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } } }
```

`reva mcp list | connect | call` or **More → MCP servers → connect all** in the PWA.
MCP tools are namespaced `mcp__<server>__<tool>` and appear to the agent like built-ins.

## Configuration

Per project: `<project>/.reva/config.json` — global: `~/.reva/config.json`. Project wins.
The full default schema (thresholds, tool policies, security limits) lives in
`src/core/config.js`. Keys **never** go in config: environment or the encrypted keystore.

## Test & verification

```bash
node --test          # 100+ tests / 8 suites, all passing
```

Suites: security adversarial (`test/security.test.js`), tools, providers (all 3 protocol
flavors against a protocol-faithful mock), MCP (against a real MCP server process), agent
loop/compaction/subagents, skills/plugins/extensions, server e2e (real HTTP+SSE), CLI/TUI
process e2e. See `docs/SECURITY.md` for the threat model the tests enforce.

## Docs

- `docs/ARCHITECTURE.md` — how the pieces fit
- `docs/SECURITY.md` — threat model, controls, and honest limits
- `docs/EXTENSIONS.md` — writing plugins and mobile extensions

## License

MIT
