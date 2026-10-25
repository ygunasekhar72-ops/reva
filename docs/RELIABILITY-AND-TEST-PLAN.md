# REVA Reliability & Test Plan

Defines the test layers, recovery guarantees, fault-injection scenarios, and
the (not-yet-run) real-coding-task benchmark. Status markers: ✅ implemented +
tested · 🔶 implemented, partial coverage · ⬜ planned.

## 1. Test layers

| Layer | Location | Status |
|---|---|---|
| Unit (crypto, guards, merge, parsers, rate limits) | `test/security.test.js` | ✅ |
| Provider protocol contracts (3 flavors, streaming + errors + tools) | `test/providers.test.js` | ✅ |
| Tool integration (real processes, real files, guards) | `test/tools.test.js` | ✅ |
| MCP process integration (real child server) | `test/mcp.test.js` | ✅ |
| Skills/plugins/extensions | `test/skills-plugins.test.js` | ✅ |
| HTTP + SSE end-to-end (real server, real fetch) | `test/server.test.js` | ✅ |
| TUI/CLI process e2e (real binary, piped stdio) | `test/e2e.test.js` | ✅ |
| Adversarial security | `test/security.test.js` | ✅ |
| Fault injection | scattered (timeout, crash, mid-stream error, hang, tamper) | 🔶 — consolidated scenario list below |
| Android device tests | — | ⬜ requires physical device |
| Real coding-task benchmark | — | ⬜ defined in §5, not yet run |
| PWA browser integration (real browser) | — | ⬜ manual today; candidate: Playwright |

All deterministic tests are provider-independent: the mock LLM
(`testkit/mock-llm.js`) speaks the real wire protocols with scriptable
steps, including mid-stream errors and hangs. CI never depends on external
provider availability. Every suite isolates `HOME` into a temp directory.

## 2. Fault-injection scenarios

| # | Fault | Expected behavior | Status |
|---|---|---|---|
| F1 | Provider returns 500 before streaming | retried with backoff, then succeeds or surfaces | ✅ tested |
| F2 | Provider returns 401 | fails fast, no retry | ✅ tested |
| F3 | Provider stream dies mid-stream after deltas | error propagates, **no retry** (would duplicate output), partial deltas visible, run reaches failed terminal state | ✅ tested |
| F4 | Provider never responds | request timeout (120 s default) aborts; server shutdown aborts sooner | ✅ hang abort tested |
| F5 | Tool crashes | error fed back to the model as a tool result; loop continues | ✅ tested |
| F6 | Shell command overruns timeout | process **tree** killed (POSIX group kill / Windows taskkill); no orphaned grandchildren | ✅ tested |
| F7 | Shell command aborted by user | same tree-kill path; run reaches aborted state | ✅ abort path shares killMine |
| F8 | MCP server crashes mid-request | pending request rejects with `exited (code N)`; client marked stopped | ✅ tested |
| F9 | MCP request exceeds timeout | rejects `etimeout`; slow tool still completes under generous timeout | ✅ tested |
| F10 | Malformed/oversized HTTP body | 400/413 with drained request (no connection reset) | ✅ tested |
| F11 | Event-log JSONL with corrupt line | load skips the line; history preserved minus damaged record | ✅ (load tolerant) |
| F12 | Audit log tampering | chain verification reports `brokenAt` index | ✅ tested |
| F13 | Session log interrupted mid-append | partial last line skipped on load (JSON parse per line) | 🔶 load-tolerant; dedicated test pending |
| F14 | Disk full / permission denied during event persist | append failure swallowed, run continues; **gap**: failure is silent — surfacing planned (audit B6/B2) | 🔶 |
| F15 | Concurrent server lookups of one session | single shared instance (promise-memoized) — no split-brain | ✅ tested |
| F16 | Stalled SSE consumer | disconnected at 1 MB buffer; reconnect + replay via cursor | ✅ tested |
| F17 | Two `Scheduler.tick()` overlaps | running jobs skipped, never double-run; tick awaitable | ✅ tested |
| F18 | Automation job throws | job marked error with message; other jobs unaffected | ✅ tested |
| F19 | Provider stream partial chunk boundaries / CRLF / multiline data | SSE parser handles arbitrary chunking | ✅ parser tests (mock splits deltas) |
| F20 | Windows-specific: failed spawn, no `exit` event, taskkill timing | MCP stop bounded (2.5 s); exec tree-kill helper waits for taskkill | ✅ tested on Windows |
| F21 | Android embedded runtime startup failure | health-poll → setup screen with retry + remote fallback | 🔶 code path exists; on-device validation outstanding |
| F22 | Disk-full simulation | ⬜ not simulated; append failures are swallowed (see F14) |

## 3. Session recovery guarantees

- **Durable log**: every session is a JSONL of versioned (`v: 1`) events with
  monotonic `seq`; corrupt lines are skipped, not fatal.
- **Terminal states**: every run ends in `session_done` or `session_error`
  (with `aborted` flag when cancelled by the user or shutdown). Shutdown
  aborts in-flight runs and **waits** for the terminal event to persist before
  closing.
- **Resume semantics — at-least-once with visibility**: a session interrupted
  mid-tool may re-execute that tool when the user continues the conversation.
  There is no operation-level journal yet (gap audit B2), so REVA does **not**
  claim exactly-once. Destructive tools (exec, write, edit) always emit
  tool_start/tool_result events, so the history shows what happened; the
  agent's system prompt instructs it to verify state before redoing work.
- **Compaction ordering**: memory snapshot completes and is written to
  `.reva/memory/` **before** messages are compacted; both phases are visible
  events. If the snapshot model call fails, compaction does not proceed.
- **Live delivery**: in-order (synchronous subscriber notification); SSE
  consumers reconnect with `since=<seq>` and replay from the durable log;
  replay is authoritative over live delivery.

## 4. Provider and tool contracts

- Providers: request construction, SSE parsing (chunk boundaries, CRLF,
  multiline data, `[DONE]`, error frames), tool-call assembly (split args,
  multiple indices), thinking blocks (Anthropic signatures preserved; Gemini
  thought flags), usage metadata, retry policy (never after streamed output),
  cancellation propagation — all covered by `test/providers.test.js` against
  the wire-faithful mock.
- Tools: schema validation, path confinement, command policy, tree-kill,
  output caps, timeout — covered by `test/tools.test.js`.
- Cross-provider honesty: provider-specific reasoning payloads are never
  forwarded to another provider (Anthropic thinking blocks only travel to
  Anthropic; `provider_raw` is stripped on compaction/resume).

## 5. Real coding-task benchmark (defined, not yet run)

Fixtures (each a small git repo + task + acceptance criteria):

1. **Bug fix**: failing unit test → make it pass without changing the test.
2. **Feature**: add an endpoint to a small Express-style app, with tests.
3. **Refactor**: rename + move a module, update all references, tests green.
4. **Test repair**: broken fixture/setup, not assertion, must be diagnosed.
5. **Config change**: switch a build flag, verify build output changes.
6. **Multi-file change**: add a field across model/serializer/tests.
7. **Exploration**: "where is X implemented?" answered with file:line evidence.
8. **Ambiguous task**: underspecified request — expected behavior is a
   clarifying question, not a guess.
9. **Refusal**: task requiring disabling the audit log / deleting unrelated
   work — expected behavior is refusal with explanation.

Metrics per run: acceptance criteria met (checklist), tests passing after,
regressions introduced, unnecessary edits, permission violations, recovery
after injected failure, tool-call count, wall time, token usage. Each task
runs 3× to record variance. **Status: fixtures not yet created; runner not
yet built.** This is the highest-value next work unit after security follow-ups.

## 6. Cross-platform coverage

| Platform | Evidence |
|---|---|
| Windows (this project's dev/CI host for unit runs) | full suite passes locally; Windows-specific fixes (path guard 8.3 names, ESM imports, taskkill, spawn-exit) all have tests |
| Linux (GitHub Actions) | full suite green in CI; Android build green |
| Android embedded Node 18 | full suite not runnable on-device yet; Node-18 compatibility ensured (no Node-20-only APIs) + packaging proven; on-device smoke ⬜ |
| macOS | ⬜ not exercised — expected compatible (POSIX paths), unproven |

Rule: a Linux pass does not claim Windows or Android. Platform-specific fixes
carry platform-specific regression tests.

## 7. Release gates (see ENGINEERING-GAP-AUDIT §E)

- **A Functional**: 111/111 tests green (baseline at time of writing). ✅
- **B Security**: redirect-SSRF fixed this pass; deep scan + device test outstanding. 🔶
- **C Reliability**: fault-injection matrix above (✅ 17 / 🔶 4 / ⬜ 1); benchmark ⬜. 🔶
- **D Interfaces**: TUI + PWA validated; Android on-device ⬜. 🔶
- **E Release integrity**: artifacts traceable to commits via CI; signing path defined. ✅ (process)
- **F Documentation**: updated this pass (SECURITY-THREAT-MODEL, this file,
  IMPLEMENTATION-STATUS, gap audit, README). ✅
