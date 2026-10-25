# REVA Engineering Gap Audit

**Phase 0 deliverable.** Evidence-based classification of every claimed capability.
Baseline: commit `9f5a4ea`, working tree clean, full suite 101/101 (`node --test`),
Android packaging proven by CI runs 40159332084 and 40161047195 (both succeeded).

Classifications: **Verified** (implementation + passing evidence) · **Partial**
(implementation exists, behavior incomplete) · **Missing** (absent) ·
**Unproven** (claimed, evidence insufficient) · **Defective** (implementation
violates its own expected behavior).

---

## A. Defective — fix in this pass (security/correctness)

### A1. `web_fetch` redirect handling bypasses the SSRF guard — **Defective (high)**
- **Evidence:** `src/tools/web.js` calls `fetch(url, { redirect: 'follow' })`
  after validating only the initial URL with `guardUrl`. A public URL that
  responds `302 → http://169.254.169.254/latest/meta-data/` (or any private
  address) is followed inside `fetch`; the guard never sees the redirect target.
  No test covers redirects.
- **Impact:** the documented SSRF protection has a viable bypass from any
  attacker-controlled page that redirects.
- **Fix:** manual redirect handling (`redirect: 'manual'`, max 5 hops), each hop
  re-validated through the full `guardUrl` policy; relative targets resolved.
- **Regression tests:** allowlisted initial host redirecting to a non-allowlisted
  private address → refused; valid chain → fetched; redirect loop → bounded
  error.

### A2. `web_fetch` downloads the entire response before capping — **Defective (medium)**
- **Evidence:** `Buffer.from(await response.arrayBuffer())` then
  `subarray(0, maxBytes)` — the full (decompressed) body is materialized in
  memory first. A large or gzip-expanded response exhausts memory; the size cap
  only protects the result string, not the download.
- **Fix:** stream the body with a hard byte budget; cancel the reader on
  overflow; report truncation.
- **Regression tests:** response larger than `max_bytes` → truncated result,
  bounded read, no exception; small response unchanged.

### A3. `exec` timeout/abort kills only the shell, orphaning descendants — **Defective (high)**
- **Evidence:** `src/tools/exec.js` uses `child.kill('SIGKILL')` on timeout and
  abort. That terminates `/bin/sh -c` or `cmd /c` but **not** the process tree
  ( grandchildren survive: `sh -c 'sleep 300 & ...'`, npm run scripts, build
  daemons). No process-group or `taskkill /T` logic exists.
- **Impact:** orphaned processes keep running after the user cancels; the
  documented "terminate owned child processes and their descendants" behavior
  does not hold.
- **Fix:** POSIX — spawn `detached: true` and kill the process group
  (`process.kill(-pid, 'SIGKILL')`); Windows — `taskkill /pid <pid> /T /F`.
- **Regression tests:** a command that spawns a grandchild which writes a
  marker file 3 s later; timeout at 0.5 s → marker must never appear (fails on
  the old code).

### A4. Provider retry after streamed output duplicates visible output — **Defective (medium)**
- **Evidence:** `src/providers/index.js` `chat()` retries any retryable error
  up to 3 times regardless of whether attempt 1 already emitted text/thinking
  deltas via `onEvent`. A 500 arriving mid-stream (after deltas) produces the
  deltas again on attempt 2 — duplicated output in TUI/PWA event streams and
  double token usage. No test distinguishes pre-stream from mid-stream errors.
- **Fix:** wrap `onEvent` to set a `streamed` flag; never retry once anything
  has been streamed (the conversation history is safe either way — only the
  final response is recorded — but visible duplication is not).
- **Regression tests:** mock emits a text delta then a mid-stream 500 → exactly
  **one** request, error propagates (fails on the old code); pre-stream 500 →
  still retries (existing behavior preserved).

## B. Partial — documented, scheduled (not silently claimed as fixed)

| # | Capability | Gap | Where | Plan |
|---|---|---|---|---|
| B1 | Optimistic concurrency for `write` | `write` overwrites unconditionally; a user change between agent read and write is silently clobbered (`edit` is inherently CAS via exact `old_string`) | `src/tools/fs.js` | content-hash precondition parameter; next pass |
| B2 | Interrupted-tool-operation journal | `session_error` marks aborted runs, but individual tool operations have no started/failed/completed/uncertain journal; resume semantics are at-least-once and undocumented at the operation level | `src/agent/` | operation journal + idempotency keys; next pass |
| B3 | Event schema versioning | events carry `seq`/`ts` but no schema version; unknown future types are already tolerated by `rebuildMessages` | `src/agent/events.js` | `v` field added this pass |
| B4 | MCP restart/reconnection | a stopped server restarts on next `connect()`; no automatic reconnection, no resubscription semantics | `src/mcp/client.js` | documented; auto-reconnect next pass |
| B5 | Automation time semantics | `every_ms` is elapsed-since-last-run (not wall-clock); `daily_at` uses server-local time; missed runs during downtime execute once on next tick (at-least-once); no persistent daemon — documented, correct for a local tool | `src/bots/automation.js` | semantics documented in RELIABILITY-AND-TEST-PLAN.md |
| B6 | Session retention | in-memory + on-disk event history is unbounded for very long sessions; compaction bounds context but not the log | `src/agent/events.js` | bounded retention policy: next pass |
| B7 | Provider capability matrix | tool-calling assumed for all models; no capability negotiation or per-model gating | `src/providers/` | catalog metadata: next pass |
| B8 | Cost accounting | usage totals recorded when providers report them; no pricing, estimates labeled as estimates | `src/agent/agent.js` | documented |
| B9 | PWA reconnection edge cases | SSE client reconnects via EventSource semantics with `since` cursor; slow-client backpressure is server-side bounded this pass; stale-tab dedupe relies on seq | `public/app.js`, `src/server` | verified basic reconnection; edge cases scheduled |
| B10 | Config validation | unknown/invalid config keys are merged silently; defaults are safe but typos go unnoticed | `src/core/config.js` | schema validation: next pass |

## C. Verified — implementation and evidence agree

- **TUI** (banner, streaming, thinking panel, tool cards, spinner, 18 slash
  commands, Ctrl+C interrupt, non-TTY mode) — `test/e2e.test.js` (9 tests, real
  processes).
- **HTTP server + PWA** (auth lifecycle, lockout, headers, SSE with replay,
  session flow, bots, extensions, memory, automation, audit endpoint, abuse
  controls 413/400/429) — `test/server.test.js` (12 tests, real HTTP).
- **Agent loop / compaction / subagents / bots / automation** —
  `test/agent.test.js` (14 tests incl. parallel fan-out and memory-snapshot
  ordering).
- **Providers as protocol contracts** — `test/providers.test.js` (13 tests vs
  protocol-faithful mock: SSE, split tool-call deltas, thinking, usage,
  retries, key resolution, conversions).
- **MCP client** — `test/mcp.test.js` (8 tests vs a real child-process server:
  handshake, list, call, timeout, crash, manager, disabled/unknown).
- **Tools** — `test/tools.test.js` (18 tests: real processes, fs roundtrip,
  path attacks, web fetch, DDG parser, guards).
- **Skills/plugins/extensions** — `test/skills-plugins.test.js` (10 tests incl.
  broken-plugin isolation and permission enforcement).
- **CLI/TUI end-to-end** — `test/e2e.test.js` (9 tests spawning the real
  binary).
- **Security controls** — `test/security.test.js` (17 adversarial tests:
  scrypt, AES-GCM tamper, lockout, tokens, redaction, pollution-safe merge,
  path-guard attack catalog, SSRF catalog, command guard, rate limits, audit
  chain tampering).
- **Android packaging** — CI runs 40159332084 and 40161047195 built the full
  APK/AAB including JNI bridge + bundled runtime (compile-level proof).

## D. Unproven / Missing — must not be claimed as done

| Item | Status |
|---|---|
| Android **on-device runtime** behavior | **Unproven** — CI compile only; no physical-device test has been executed |
| Full deep security scan | **Outstanding** — Mimosa's last passes reported partial coverage |
| TLS termination | **Missing by design** — bind loopback or use a reverse proxy |
| Shell sandboxing (OS-level) | **Missing by design** — exec guard is policy, not isolation; hostile-code threat model explicitly unsupported in current mode |
| DNS-rebinding TOCTOU in `web_fetch` | **Partial** — initial resolution validated, fetch re-resolves; redirect fix (A1) closes the redirect bypass but not rebinding; see SECURITY-THREAT-MODEL.md |
| Real coding-task benchmark | **Missing** — fixture set + success criteria defined in RELIABILITY-AND-TEST-PLAN.md, not yet run |
| Benchmarks (large repos, many clients) | **Missing** — measure before optimizing |
| Bounded retention / rotation | **Missing** (B6) |
| Account recovery / password reset | **Missing by design** — documented: delete `~/.reva/accounts.json` (local-first trade-off) |

## E. Release blockers (Gate B/D per release checklist)

1. ~~web_fetch redirect SSRF bypass~~ — **fixed this pass** (A1).
2. Android on-device smoke test — **outstanding** (requires a physical device).
3. Full deep security scan — **outstanding**.
