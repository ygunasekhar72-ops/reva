# REVA — Full Build Report

**Date:** 2026-10-25 · **Version:** 1.0.0 · **Commit:** `296e7b1` · **Repo:** github.com/ygunasekhar72-ops/reva (private)
**Code:** 88 tracked files · 6,541 lines in `src/` · 2,814 lines of tests · 986 lines PWA · 525 lines Android · **101 tests, all passing**

REVA (named by the owner) is a zero-dependency AI agent harness: an AI agent that
works inside your project with a fully visible thinking process, delivered three
ways from one codebase — a terminal UI, a browser/mobile PWA served by an
embedded HTTP server, and a standalone Android app that runs the entire harness
on the phone. Pure Node.js ≥18.17 stdlib: **no npm packages, no build step, no
supply chain.**

---

## 1. The three run modes

| Mode | Command | What runs where |
|---|---|---|
| Terminal TUI | `node bin/reva.js` | agent + UI in your terminal (Windows/Linux/macOS/Termux) |
| Server + PWA | `node bin/reva.js serve` | HTTP API + web app on `127.0.0.1:7463`; phone installs it via "Add to Home Screen" |
| Standalone Android | `android/` → CI-built APK | embedded Node.js runtime (nodejs-mobile) runs the whole harness on the phone; WebView loads `127.0.0.1:7463` |

All three share one runtime (`src/core/harness.js`) and one per-project state
directory (`.reva/`) — sessions created in the app appear in `reva sessions
list` and vice versa.

## 2. Agent core

- **Agent loop** (`src/agent/agent.js`): system prompt assembly → provider call
  (streaming) → tool rounds → final answer. Iteration cap (default 24),
  temperature, per-request timeout, abort support.
- **Event sourcing** (`src/agent/events.js`): every visible step is an event
  (user message, thinking delta, text delta, tool start/result with timings,
  compaction phases, subagent lifecycle, usage). Subscribers are notified
  synchronously in-order; events persist as JSONL per session and replay on
  resume. This is the visible thinking process, shared by TUI and PWA.
- **Sessions**: persisted JSONL + index; resumable across restarts
  (`rebuildMessages` folds events back into messages).
- **Subagents / multi-agent**: the `task` tool spawns child sessions (depth
  limit, concurrency limit, `explore` = read-only mode). Multiple task calls in
  one turn run **concurrently** (bounded worker pool). Child events mirror into
  the parent log.
- **Compaction with memory-first** (`src/agent/memory.js`): when estimated
  tokens cross the threshold, the model first distills the conversation into
  durable notes (summary, decisions, facts, todos, gotchas) written to
  `<project>/.reva/memory/`, then the conversation is replaced by the summary
  + recent messages. Every project gets its own memory workspace; notes are
  injected into future sessions' system prompts.
- **Node 18 compatibility**: no Node-20-only APIs (AbortSignal.any replaced
  with a manual combiner), so the same code runs in the embedded Android
  runtime.

## 3. AI providers (`src/providers/`)

| Provider | Protocol flavor | Notes |
|---|---|---|
| OpenAI | `/chat/completions` + SSE | tool-call delta assembly, `reasoning_content` passthrough |
| Grok (xAI), DeepSeek, OpenRouter, Ollama, LM Studio, any compatible | same | configurable `base_url` |
| Anthropic | `/v1/messages` + SSE | thinking blocks with signatures preserved across tool loops |
| Google Gemini | `streamGenerateContent` + SSE | thought summaries, JSON-schema sanitization |

- Key resolution order: **encrypted keystore → config → environment variable**.
- Retry with jittered backoff on 429/5xx only; 401/403 fail fast.
- `listModels` per provider; provider catalog exposed to the PWA.
- Normalized event stream (thinking / text / tool_call / usage / stop) and
  normalized errors (`ProviderError` with retryable classification).

## 4. Tools (13, `src/tools/`)

`exec` (shell with two-layer guard, timeout, output caps, sanitized env), `read`,
`write`, `edit` (exact-match replacement), `list` (recursive walk with skip
list), `grep` (regex, binary-safe), `web_search` (DuckDuckGo HTML, no key;
optional Brave/Tavily via stored keys), `web_fetch` (SSRF-guarded, HTML→text),
`skill`, `memory_save`, `memory_read`, `todo` (plan tracking), `task`
(subagents). Plus tools registered by plugins and MCP servers. Every execution:
JSON-schema validation, plugin pre/post hooks, timing events, normalized
errors.

## 5. Extensibility

- **MCP** (`src/mcp/client.js`): real MCP stdio client (JSON-RPC 2.0):
  initialize handshake → tools/list → tools/call. Namespaced tools
  (`mcp__<server>__<tool>`), per-request timeouts, deterministic rejection on
  server crash, disabled-server support, manager for multi-server setups.
- **Skills** (`skills/` + `src/skills/`): markdown `SKILL.md` packages with
  frontmatter; layered discovery (built-in < global < project); catalog
  injected into the system prompt; bodies loaded via the `skill` tool.
- **Plugins** (`plugins/` + `src/plugins/`): `plugin.json` manifest + JS
  `activate(ctx)`; permission-gated (`tools`, `events`, `network`,
  `filesystem`, `shell`); tools namespaced `plugin__<name>__<tool>`;
  per-plugin error isolation (a broken plugin can never take the harness
  down — tested). Bundled `sample` plugin ships a working tool + hooks.
- **Mobile extensions** (`extensions/`): browser-side modules for the PWA
  (`registerCard`, `addCommand`, `fetch`, `notify`); permission-declared
  manifests; served at registry-keyed URLs so no request path reaches the fs.
  Bundled `system-status` extension.

## 6. Bots & automation

- **Bots** (`src/bots/index.js`): named agent presets on your own keys.
  Built-ins: **`dots`** (OpenAI, gpt-4o-mini) and **`grok`** (xAI,
  grok-3-mini) — both with personas. Create your own (`reva bot add`),
  constrain with `tools_allow` and `max_iterations`.
- **Automation** (`src/bots/automation.js`): persisted jobs (interval or
  daily-at HH:MM), validation, `Scheduler` with awaitable ticks, no
  double-runs, per-job ok/error status tracking. Runs under `serve`, the TUI
  host, or `reva auto daemon`.

## 7. Security (all controls have tests — see `docs/SECURITY.md`)

- **Passwords**: scrypt (N=2¹⁵), per-account salt, NFKC, `timingSafeEqual`,
  timing-burn on unknown users; weak passwords refused with 400.
- **Login**: bootstrap-once first admin; brute-force lockout (5 tries → 15
  min) + per-IP auth rate limit; bearer tokens (256-bit, stored as SHA-256,
  sliding 12h TTL, revocation, 16-per-user cap).
- **Keystore**: AES-256-GCM, scrypt-derived master key, per-secret IV, auth
  tags (wrong password / tamper fail loudly), master-password rotation.
- **Path guard** (`src/security/pathguard.js`): one choke point for every file
  tool — blocks absolute paths, drive letters, UNC, `..`, all-dot segments,
  control bytes, and symlink/junction escapes (realpath-based, Windows 8.3
  short-name safe).
- **SSRF guard** (`src/security/ssrf.js`): scheme allowlist, credential-in-URL
  refusal, DNS resolution with fail-closed, private/loopback/link-local
  (metadata)/CGNAT/ULA/multicast/mapped-IPv6 blocking; allowlist override for
  local dev.
- **Command guard** (`src/security/cmdguard.js`): block list (never runs,
  confirmation can't override) + audit list (confirm/block/audit modes); exec
  disabled over the network by default; provider-key env vars stripped from
  child processes.
- **Server hardening**: strict CSP (no remote/inline scripts, frame-ancestors
  none), X-Frame-Options, nosniff, no-referrer, COOP/CORP, no-store; exact
  match static routing (no request path reaches fs); 2 MB body cap with clean
  413 drain; JSON depth cap; rate limits (240/min API, 10/min auth); 500s
  without internal details.
- **Audit log**: JSONL with SHA-256 hash chain — tampering is detectable
  (`reva doctor`, `/api/audit`, PWA panel). All entries pass the redactor.
- **Redaction** (`src/security/redact.js`): key-shaped patterns + sensitive
  field masking across every log/audit write.

**Honest limits** (documented): DNS-rebinding TOCTOU in web_fetch; exec is
policy, not a sandbox; tokens live in browser storage; no TLS termination
(bind 127.0.0.1 / use a reverse proxy).

## 8. Interfaces

- **TUI** (`src/tui/index.js`): inline streaming (works over SSH/Termux),
  dim thinking panel, tool cards with timings, spinner, Ctrl+C interrupt,
  18 slash commands (`/help /new /sessions /resume /provider /model /bots
  /bot /skills /tools /memory /todos /compact /clear /quit`…), non-TTY
  scripted mode (used by e2e tests).
- **PWA** (`public/`): login/bootstrap, chat with collapsible thinking blocks
  and tool cards over SSE, sessions, bots runner, provider keys, skills/
  plugins/extensions/MCP panels, memory viewer, automation manager, audit
  chain verifier, service worker (shell only), installable manifest.
- **CLI** (`bin/reva.js` → `src/core/cli.js`): `serve`, `run` (one-shot,
  `--json`), `auth init|status|key`, `sessions list|show`, `bot
  list|run|add|remove`, `auto list|add|remove|daemon`, `mcp
  list|connect|call`, `skill list|show`, `plugin list`, `memory`, `doctor`,
  `version`, `help`.

## 9. Android app (`android/`) + Play Store pipeline

- Embedded Node.js 18.20.4 runtime (nodejs-mobile `libnode`, fetched per ABI
  at build time), JNI bridge (`native-lib.cpp` + CMake, NDK 26.1), WebView
  shell over `127.0.0.1:7463` — the whole harness on the phone, offline.
- First-run "START ON-DEVICE" + "connect to remote" fallback; adaptive B/W
  launcher icons (pure XML); cleartext enabled for LAN/local HTTP
  (documented trade-off).
- CI (`.github/workflows/android-build.yml`): bundles `src/ public/ skills/
  plugins/ package.json standalone.js` into APK assets, fetches libnode,
  compiles the JNI bridge with NDK 26.1, outputs `app-debug.apk`, release
  APK, and `.aab` (signed when the 4 keystore secrets are set). **Two
  successful production-style builds** (runs 40159332084, 40161047195 —
  143.8 MB artifact).
- `docs/PLAYSTORE.md`: signing + secrets + Play Console checklist (data
  safety "no data collected", cleartext justification, store listing draft).

## 10. Testing — 101 tests, 8 suites, all green

| Suite | Tests | Covers |
|---|---|---|
| `security.test.js` | 17 | crypto, keystore, accounts/lockout, sessions, redaction, pollution-safe merge, path guard attack catalog, SSRF catalog, command guard, rate limits, audit tamper detection |
| `tools.test.js` | 18 | registry validation/events, exec (real processes, timeouts, guards), fs roundtrip + attacks, web fetch + SSRF + DDG parser, memory, todo, skill |
| `providers.test.js` | 13 | all three protocol flavors vs protocol-faithful mock (SSE, delta assembly, thinking, tool calls), errors/retries, key resolution, conversions |
| `mcp.test.js` | 8 | real MCP server process: handshake, list, call, timeout, crash, manager, disabled/unknown |
| `skills-plugins.test.js` | 10 | skill discovery/overrides, sample plugin, permissions, broken-plugin isolation, extensions serving/validation |
| `agent.test.js` | 14 | loop, tool rounds, failures-fed-back, subagents, parallel fan-out, compaction w/ memory snapshot, resume, bots, automation |
| `server.test.js` | 12 | auth lifecycle, lockout, headers, traversal, full agent flow over SSE, exec-disabled-over-server, bots, extensions, memory/automation/audit, abuse controls (413/400/429), MCP endpoints |
| `e2e.test.js` | 9 | real CLI/TUI processes: `run --json`, doctor, bot run, piped TUI session, `/help`, version/help, unknown command |

Methodology: a protocol-faithful **mock LLM** (all three flavors, split
tool-call deltas, error injection) and a **real MCP server process**; the
server suite boots the real HTTP stack on ephemeral ports; CLI/TUI tests spawn
the real binary. Every suite isolates `HOME` into temp dirs
(`testkit/env.js`), so parallel execution is safe. **Full suite verified 101/101
across 3 consecutive runs.**

### Bugs the tests caught and I fixed (selection)

1. Keystore rejected the `provider:<name>` secret names the harness itself uses.
2. Lockout reported the wrong error on the triggering attempt; verifyPassword
   crashed on invalid input instead of returning false.
3. `dangerous_mode: 'block'` silently allowed flagged commands.
4. Path guard mixed real/non-real path prefixes (Windows 8.3 short names) →
   full realpath-of-deepest-existing redesign; also `toRelative` breakage.
5. Windows ESM dynamic import required `pathToFileURL`.
6. `McpClient.stop()` hung forever on failed spawns (Windows emits no `exit`).
7. **Out-of-order event delivery** — EventLog notified subscribers after an
   await, scrambling streamed deltas under concurrency.
8. Millisecond temp-file collision in atomic writes killed parallel subagents.
9. Server `_getSession` race created two session instances (SSE split-brain).
10. Logout revoked the token before verifying it.
11. Rate-limiter config mapping (`max_requests` vs `max`) — limits never engaged.
12. Static/extension serving: leading-slash and traversal handling → replaced
    with exact-match routing + registry-keyed serving after scanner review.
13. TUI never printed assistant text; banner crashed in non-TTY; non-TTY stdin
    conflict with readline.
14. `process.exit` triggered a libuv fail-fast on Windows → `exitCode` instead.
15. Exec's env-chosen shell (`ComSpec`) → fixed system shells.
16. 413 responses reset the connection mid-upload → request drained.
17. `/api/me` lacked role; prototype-pollution refusal added to config merge.

## 11. Repository state

- 4 commits (`5c84eac` v1.0.0 → `0ef91b9` android shell → `ae4d4f8` CI fix →
  `296e7b1` standalone), pushed to **github.com/ygunasekhar72-ops/reva**
  (private; `gh repo edit --visibility public` to publish).
- `.gitignore` excludes `.reva/` (all runtime state) and `.mimosa/`;
  `.gitattributes` normalizes LF; MIT `LICENSE`.
- Topics: ai-agent, agent-harness, ai-tools, cli, llm, mcp, nodejs, pwa,
  terminal, zero-dependency.
- Docs: README (quickstart, modes), SECURITY (threat model + limits),
  ARCHITECTURE (data flow, testing strategy), EXTENSIONS (plugin/extension/
  MCP/skill authoring), PLAYSTORE (signing + Console checklist).
- Live artifact: `reva-android` (143.8 MB) from run 40161047195 (expires
  2027-01-23).

## 12. What was verified vs what needs a phone

**Verified here:** 101/101 tests (×3 consecutive full runs); live server smoke
(health, PWA assets with MIME types, security headers, bootstrap→login→
session→skills→audit over curl); Android pipeline compiles end-to-end in CI
(twice), including the JNI bridge against libnode headers and asset bundling.

**Not executable here:** runtime behavior on a physical device (no emulator on
this machine) — first on-device boot is the remaining smoke test; and the
scanner noted its last-pass analysis coverage was partial, so a full deep
security scan is recommended before publishing the repo or shipping to Play.
