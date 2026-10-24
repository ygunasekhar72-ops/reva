# REVA Security Model

This document describes REVA's threat model, the controls that enforce it, and
— explicitly — the limits that remain. Every control listed here has tests;
the point of this file is that nothing is asserted without evidence.

## Test evidence

`node --test` runs the adversarial suite in `test/security.test.js` plus
security-relevant coverage across every other suite (server headers, auth
flows, rate limits, path guards on every tool, exec-over-server refusal,
audit chain tampering, extension serving traversal). If a control below has
no test, treat it as not implemented.

## 1. Credentials at rest

**Control.** Provider API keys live only in the encrypted keystore
(`~/.reva/keystore.json`): AES-256-GCM with a per-secret random IV, sealed
under a master key derived from the user's master password via scrypt
(N=2^15, r=8, p=1). The GCM auth tag makes wrong-password unlocks and
ciphertext tampering fail loudly.

- Password hashes: scrypt with a per-account random salt; `timingSafeEqual`
  comparison; NFKC normalization.
- Weak passwords (< 8 chars) are refused at the API layer with 400.
- Tests: `crypto: …` block — roundtrip, tamper bit-flip, wrong password,
  keystore lifecycle, master-password rotation.

**Limits.** The master key is held in process memory while unlocked. A full
memory-dump attacker on a running session can read unlocked keys. This is the
standard trade-off for a local-first tool.

## 2. Login system

**Control.** The HTTP API requires a bearer token for everything except
`GET /health` and `/api/auth/*`. Anonymous local access is opt-in
(`server.allow_anonymous_local: true`) **and** restricted to loopback IPs.

- Session tokens: 256-bit CSPRNG, shown once, stored only as SHA-256 digests.
  Stealing `sessions.json` cannot mint a valid token.
- Sliding TTL (default 12h), logout revocation, per-user revocation, cap of
  16 sessions per user.
- Brute force: per-IP+path auth rate limit (default 10/min) **and** account
  lockout after 5 failed logins (15 min default). Unknown usernames burn an
  equivalent scrypt cost to blunt timing-based user enumeration.
- The first registered account becomes admin; `bootstrap` refuses once an
  account exists. The audit log records registration.
- Tests: server auth lifecycle, lockout over HTTP, rate-limit engagement,
  garbage-token rejection.

**Limits.** Bearer tokens live in the PWA's `localStorage`/`sessionStorage`
(XSS would expose them; the CSP bans all remote script origins to shrink that
surface). For hostile networks, put the server behind a reverse proxy with
TLS — REVA itself binds 127.0.0.1 by default and does not terminate TLS.

## 3. Filesystem confinement (path guard)

**Control.** Every file-touching tool resolves paths through one choke point
(`src/security/pathguard.js`). Refused: absolute paths, drive letters, UNC
shares, `..` segments, all-dot segments (`....//`), null/control bytes, and
**symlink/junction escapes** (deepest-existing-ancestor realpath resolution on
both the base and the target, so real and display paths can never diverge —
this also handles Windows 8.3 short names).

- Tests: the full attack catalog in `path guard: …` blocks + junction-escape
  test + per-tool refusal tests (read/write/edit with traversal payloads).

## 4. SSRF guard (web tools)

**Control.** `web_fetch` validates every URL through `src/security/ssrf.js`:
http/https only, no credentials-in-URL, blocklist/allowlist support, DNS
resolution with **fail-closed** on unresolvable hosts, and refusal of any
resolved address that is loopback, private (RFC1918, CGNAT), link-local
(including cloud metadata `169.254.169.254`), multicast, IPv4-mapped-IPv6, or
IPv6 ULA. Private targets are fetchable only with an explicit
`tools.web.allow_private_addresses: true` or a host allowlist (needed for
local development).

- Tests: 25+ URL/IP attack vectors in `ssrf: …` blocks; live local fetch with
  allowlist; default-deny probe.

**Limits.** Classic TOCTOU: REVA resolves DNS for validation, then `fetch`
resolves again. A DNS-rebinding attack that flips between a public IP
(validation) and a private IP (connection) within one request is *not*
blocked, because Node's fetch cannot pin the validated IP without native
dispatch hooks. Mitigation if you need it: run REVA in a network namespace
that cannot reach private ranges.

## 5. Command execution guard

**Control.** The `exec` tool runs commands through a two-layer guard
(`src/security/cmdguard.js`):

1. **Block list** — never executed in any mode: `rm -rf /`, `mkfs`, raw
   `dd of=/dev/…`, fork bombs, `shutdown`, forced registry deletes, `chmod 777 /`,
   and similar. Confirmation cannot override this layer.
2. **Audit list** — flagged as dangerous (deletions, `sudo`, package installs,
   `curl | sh`, command substitution, …). Policy `tools.exec.dangerous_mode`:
   `confirm` (default — the agent must re-run with `confirmed=true`, and the
   flag is surfaced to the user), `block`, or `audit`.

Additional layers: exec is **disabled over the network server by default**
(`enabled_over_server: false`) — the PWA agent cannot run shell commands
unless you accept that explicitly. Child processes run with a sanitized
environment: any env var matching `API_KEY|SECRET|TOKEN|PASSWORD` is stripped,
so provider keys never leak into build tools or test runs. Hard timeout,
output caps, and SIGKILL on overrun. Every flagged execution is audit-logged.

- Tests: block-list catalog, confirmation modes, server refusal, timeout kill,
  exit-code/stderr capture.

**Limits.** This is policy, not a sandbox. The exec tool runs as the OS user
and can read anything that user can read. Strong isolation requires running
REVA inside a container/VM — recommended for untrusted workloads.

## 6. Prompt-injection and exfiltration posture

The system prompt forbids printing/copying credentials found in files, but
prompt injection is an **unsolved industry problem**: malicious web content or
repo files can still instruct the model to misuse tools. REVA's structural
mitigations are the ones above (SSRF guard, exec disabled over server,
confirmation gates, path confinement) plus a complete audit trail. Do not
give the agent keys you cannot afford to lose while it browses untrusted web
content.

## 7. HTTP surface hardening

- CSP: `default-src 'self'; script-src 'self'` (no remote scripts, no inline
  scripts), `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'self'`.
- `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, COOP/CORP,
  `Permissions-Policy` locking camera/mic/geolocation, `Cache-Control: no-store`.
- JSON body parsing: 2 MB cap (413 with the request drained so clients get a
  clean response), depth cap (32), object-root enforcement.
- Global API rate limit per IP (default 240/min) + separate auth limiter.
- 500 responses never leak stack traces or internal messages.
- Static serving is path-guarded (traversal, dot-segments, null bytes) with an
  SPA fallback that cannot escape the public dir; extension files are served
  only from their declared directories through the same guard.
- Tests: header assertions, traversal probes (including the forms that survive
  client-side URL normalization), 413/400 behavior, 401/429 engagement.

## 8. Audit log

Append-only JSONL with a **SHA-256 hash chain** (`prev_hash` links every
entry): silent edits, deletions, or reorderings are detectable via
`reva doctor` / `GET /api/audit` / the PWA's audit panel. All entries pass
through the redactor (key patterns + sensitive field names) — secrets cannot
enter the log. Records: auth events, key set/remove, bot runs, dangerous tool
calls, web fetches, compactions, config changes.

- Tests: chain verification, tamper detection (brokenAt index), redaction
  assertion on a recorded secret.

## 9. Supply chain

`package.json` declares **zero runtime dependencies**. There is no `npm
install`, no transitive packages, no build step, no postinstall scripts. The
only executable surface is this repository plus the Node.js runtime itself.
Test doubles (mock LLM, mock MCP server) are part of the repo, not downloaded.

## 10. Data locality

All project state (memory, sessions, bots, automation, audit) lives in
`<project>/.reva/`; all identity state in `~/.reva/`. Nothing leaves the
machine except the model API calls you configure (and `web_search`/`web_fetch`
when the agent uses them — both audit-logged).
