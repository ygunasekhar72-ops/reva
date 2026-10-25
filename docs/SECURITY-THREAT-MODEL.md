# REVA Security Threat Model

**Companion to `docs/SECURITY.md` (controls) and `docs/ENGINEERING-GAP-AUDIT.md`
(current findings).** This document defines who the attackers are, what they
want, where the boundaries are, and what residual risk the owner accepts by
running REVA.

## 1. Assets

- Provider API keys (OpenAI/Anthropic/Gemini/…) — direct financial value.
- The user's project files and git history.
- Session/event history (may contain code, secrets encountered in files, plans).
- The encrypted keystore and account store (`~/.reva/`).
- Audit log (integrity-sensitive: tamper evidence).
- The host machine itself (via the exec tool).

## 2. Trust boundaries

| Boundary | Crossing |
|---|---|
| Model ↔ harness | tool-call decisions (model output is untrusted data) |
| Project content ↔ agent | files, READMEs, MCP output, tool output (prompt injection is possible by design of LLMs) |
| Web ↔ agent | `web_fetch`/`web_search` results — untrusted content *and* untrusted network position |
| Network ↔ HTTP server | REST/SSE clients (authentication required; loopback default) |
| Plugins/extensions ↔ harness | executable code (plugins: full process privileges; extensions: browser sandbox) |
| Embedded Node ↔ Android app | in-process runtime, app-sandboxed filesystem |

## 3. Attacker models and outcomes

| # | Attacker | Capability | Objective | Defense | Residual risk |
|---|---|---|---|---|---|
| 1 | Trusted local developer | everything | — | out of scope (this is the user) | — |
| 2 | **Malicious repository content** | files, instructions in README/skills | exfiltrate keys; destructive commands; persistence | prompt rules against credential handling; command guard (block list, confirmation); path confinement; exec disabled over network; audit log | prompt injection remains an unsolved industry problem — the model may be convinced to misuse allowed tools; the guards bound *what* it can do, not *whether* |
| 3 | **Untrusted webpage** (fetched by the agent) | content; server-side redirects; huge responses | SSRF to metadata/private services; prompt injection; resource exhaustion | per-hop SSRF validation (redirect fix, 2026-10-25); bounded streaming read; truncation; audit entries | DNS-rebinding TOCTOU: fetch re-resolves DNS after validation (no enforced destination pinning in portable Node) — see §6 |
| 4 | **Malicious MCP server** | protocol responses; tool results | inject instructions; huge payloads; hang the client | per-request timeouts; JSON-RPC framing; schema-validated tool args; namespacing; audit | a malicious server's *tool results* are still model-visible content (attacker model #2 applies) |
| 5 | **Malicious plugin** | arbitrary Node code | privilege escalation | it is trusted code by installation decision — permission declarations gate *harness API usage*, not OS privileges (documented; no process sandbox claimed) | full host access — treat plugin installation like installing any program |
| 6 | **Unauthenticated network client** | HTTP requests to the server | data theft; RCE via tool endpoints | auth required for all non-health/auth routes; rate limits; body caps; CSP; no keys in responses; exec disabled over network; loopback default bind | tokens in browser storage (XSS surface minimized by CSP); if bound to LAN without auth config, an attacker on the network can attempt login (rate-limited, lockout enforced) |
| 7 | **Authenticated low-privilege client** | valid token | reach other users' sessions/projects | sessions are per-token; project scope fixed at server start; admin-only audit endpoint | single-workspace-per-server (no multi-tenant isolation) — documented |
| 8 | **Malicious local process** | same OS user as REVA | read unlocked keys, steal sessions | keystore encrypted at rest; locked in memory while unlocked is the accepted trade-off | anything running as the user can do everything the user can — outside REVA's control |
| 9 | **Arbitrary code via exec tool** | the command the agent runs (with confirmation) | anything the user can do | block list (non-overridable) + confirmation gate + tree-kill on timeout/abort + audit; **not a sandbox** | explicit: hostile-code execution is an *unsupported threat model* without an OS-level sandbox (container/VM) |
| 10 | **Compromised provider/extension** | returned content | injection, wrong results | same as #3/#4 | provenance not verified (no signature pinning on provider responses) |

## 4. Security objectives

1. Provider keys never appear in logs, audit records, tool output, child-process
   env, HTTP responses, or error messages (tested).
2. Filesystem access stays inside the workspace root, including via symlinks
   and Windows path aliases (tested).
3. Network fetches cannot reach private/metadata addresses, including through
   redirects (tested as of the 2026-10-25 fix) — with the DNS-rebinding
   residual risk below.
4. Dangerous shell operations require explicit confirmation and are
   audit-logged; a small non-overridable block list always refuses.
5. The HTTP surface requires authentication; session state cannot be reached
   by another user; brute force is rate-limited and locked out (tested).
6. Security-relevant actions are recorded in a tamper-evident chain (tested).
7. Failure of any component (provider, MCP server, plugin, disk) degrades
   without escalating privilege.

## 5. Attack-surface notes per subsystem

- **HTTP**: 30+ endpoints, all non-health/auth routes authenticated. Static
  serving is exact-match (no request path reaches fs). Extension serving is
  registry-keyed. SSE per-session; unauthenticated subscription impossible.
- **SSE**: slow clients are disconnected at 1 MB of buffered output
  (reconnect + replay via cursor); per-session subscriptions.
- **exec**: fixed system shells only; env-sanitized children (no `*KEY*`,
  `*SECRET*`, `*TOKEN*`, `*PASSWORD*` vars); hard timeout with **process-tree
  termination** (POSIX group kill / Windows taskkill via fixed helper — no
  variable arguments); output caps.
- **Android**: embedded Node is compiled from the nodejs-mobile release
  (provenance: pinned release URL in CI; checksum verification is a planned
  improvement); workspace is app-private storage; loopback-only server.

## 6. Residual risks (accepted, by deployment mode)

| Risk | Applies to | Mitigation path |
|---|---|---|
| DNS-rebinding TOCTOU (validate resolves public, fetch re-resolves private) | any `web_fetch` of attacker-chosen URLs | run REVA in a network namespace that cannot reach private ranges; or a future destination-pinning implementation |
| Prompt injection steering allowed tools | always (LLM-inherent) | least-privilege config (`tools_allow` for bots/subagents), confirmation gates, audit |
| Shell tool as the user | always when exec enabled | container/VM for hostile workloads; `enabled_over_server: false` default |
| Token theft from browser storage | PWA/Android WebView | CSP shrinks XSS surface; reverse proxy + HTTPS for LAN/WAN exposure |
| No TLS termination | LAN/WAN deployments | reverse proxy (caddy/nginx) + HTTPS |
| Unbounded event-log growth | very long-lived sessions | retention policy (tracked in gap audit B6) |
| Plugin/extension = trusted code | after user installs | install only reviewed code; extension serving is containment-hardened |

## 7. Verification status

- Every "Defense" marked (tested) above has an automated adversarial test in
  `test/security.test.js` or the relevant suite — see
  `docs/IMPLEMENTATION-STATUS.md` for the exact mapping.
- Outstanding: physical-device Android validation; a full deep security scan
  (the in-repo Mimosa gate reported partial coverage on its passes); DNS
  rebinding mitigation.
