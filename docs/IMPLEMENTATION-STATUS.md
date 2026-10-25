# REVA Implementation Status

Per-item status for the audit backlog in `docs/ENGINEERING-GAP-AUDIT.md`.
Every "done" entry lists the exact evidence. Nothing here is marked complete
on the basis of written-but-unexecuted code.

**Snapshot:** commit `@HEAD` (docs pass) · full suite **111/111** (`node --test`)
· baseline before this pass was 101/101.

## Fixed this pass (Defective → Verified)

| ID | Item | Implementation | Tests | Result | Residual |
|---|---|---|---|---|---|
| A1 | web_fetch redirect SSRF bypass | `src/tools/web.js` — manual redirects (max 5), every hop re-validated through `guardUrl` with the same policy; relative targets resolved | `tools.test.js`: redirect-SSRF refusal, valid chain, loop bound | all pass; refusal test fails on the old code | DNS-rebinding TOCTOU remains (threat model §6) |
| A2 | web_fetch unbounded download | `src/tools/web.js` — streaming read with hard byte budget; reader cancelled on overflow; `truncated` + `bytes` reported | `tools.test.js`: 8 MB body vs 1 MB budget → truncated, bounded | pass | — |
| A3 | exec orphaned process trees | `src/tools/exec.js` — POSIX: `detached` + `process.kill(-pid)`; Windows: fixed helper script runs `taskkill /T /F` with pid via env (no variable args); helper **waits** for taskkill (diagnosed: exiting early tore down the tree walk); `timed_out` from explicit kill marker | `tools.test.js`: grandchild-marker test (fails on old code); 3 stability reruns | pass ×3 | Windows Job Objects would be stronger; taskkill /T verified empirically on the cmd→node→node tree |
| A4 | retry after streamed output | `src/providers/index.js` — `streamed` flag via guarded onEvent; never retry post-stream | `providers.test.js`: mid-stream 500 → exactly 1 request, deltas once; pre-stream 503 → still retried | pass | partial deltas remain visible before the error (by design, honest UI) |
| F16→ | SSE slow clients | `src/server/index.js` `_sse` — disconnect at 1 MB buffered output; reconnect+replay via cursor | `server.test.js`: stalled-consumer test (fake sink, flood, assert destroyed) | pass | replay correctness covered by existing since-cursor tests |
| — | server shutdown | `RevaServer.close()` aborts all in-flight runs and awaits their persisted terminal state; idempotent | `server.test.js`: hanging-provider run + close → `session_error{aborted}` persisted, no `session_done` | pass | — |
| B3→ | event schema version | `EventLog.append` stamps `v: 1`; rebuild tolerates unknown types | `server.test.js`: version present; unknown type ignored on rebuild | pass | — |
| F17→ | scheduler double-run guard | `Scheduler.tick()` awaits its launched batch (also enables deterministic tests/graceful stop) | `agent.test.js`: awaitable tick, status ok | pass ×3 | — |

## Outstanding backlog (from gap audit, priority order)

| ID | Item | Status | Next action |
|---|---|---|---|
| B1 | write-tool optimistic concurrency | not started | add content-hash precondition param |
| B2 | operation journal / idempotency for interrupted tools | not started | per-tool started/failed/uncertain journal in session dir |
| B4 | MCP auto-reconnect | not started | reconnect with backoff on unexpected exit |
| B6 | event-log retention/rotation | not started | size-bounded rotation, keep terminal events |
| B7 | provider capability matrix | not started | per-model tool/streaming support metadata |
| B8 | cost accounting | usage recorded only | optional price table, labeled estimates |
| B9 | PWA reconnection edge cases | basic verified | stale-tab dedupe tests |
| B10 | config schema validation | not started | unknown-key warning + type validation |
| D1 | Android on-device validation | **blocked on physical device** | smoke checklist in PLAYSTORE.md |
| D2 | deep security scan | **outstanding** | run full Mimosa scan (partial coverage noted on all passes) |
| D3 | DNS rebinding mitigation | open (documented) | destination pinning via custom undici dispatcher — needs a dependency decision (zero-dep policy) |
| D4 | real coding-task benchmark | fixtures + runner not built | see RELIABILITY-AND-TEST-PLAN §5 |
| D5 | disk-full / fault injection for persistence | not simulated | F14/F22 |
| D6 | macOS validation | not exercised | CI matrix candidate |
| D7 | bounded log retention | not started | with B6 |

## Verification log (this pass)

| Command | Outcome |
|---|---|
| `node --test` (baseline, before changes) | 101/101 pass |
| `node --test --test-name-pattern="redirect\|oversized\|truncated during" test/tools.test.js` | 4/4 new tests pass |
| `node --test --test-name-pattern="exec tool" test/tools.test.js` | 5/5 pass (after two debug iterations) |
| `node --test test/providers.test.js` | 15/15 pass (2 new) |
| `node --test --test-name-pattern="close() aborts\|stalled consumer\|schema version" test/server.test.js` | 3/3 pass (after savedHome/path fixes) |
| `node --test` (full suite, after all fixes) | **111/111 pass** |
| `git commit` × 6 (audit doc, web fix, exec fix, retry fix, server fix, docs) | all passed the pre-commit security gate |
