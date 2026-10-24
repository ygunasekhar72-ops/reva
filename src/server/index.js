// REVA HTTP server: REST API + SSE event streaming + static PWA hosting.
// Security posture:
//  - auth required for everything except /health and /api/auth/*  (local
//    anonymous mode is opt-in via server.allow_anonymous_local AND loopback)
//  - strict security headers incl. CSP without unsafe-inline for scripts
//  - body size caps, JSON parse/depth guards, rate limiting (global + auth)
//  - provider keys never leave the server; audit trail for auth + dangerous ops
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { RateLimiter, RateLimitError } from '../security/ratelimit.js';
import { AuthError } from '../security/accounts.js';
import { log } from '../util/log.js';
import { newId } from '../util/ids.js';
import { APP_ROOT } from '../core/harness.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export class RevaServer {
  constructor({ harness, publicDir = path.join(APP_ROOT, 'public'), host, port, tls = null }) {
    this.harness = harness;
    this.publicDir = path.resolve(publicDir);
    this.host = host ?? harness.config.get('server.host');
    this.port = port ?? harness.config.get('server.port');
    this.tls = tls;
    this.server = null;
    this.apiRate = this._makeLimiter('security.api_rate');
    this.authRate = this._makeLimiter('security.auth_rate');
    this.runningRuns = new Map(); // sessionId -> promise
  }

  get allowAnonymous() {
    return this.harness.config.get('server.allow_anonymous_local') === true;
  }

  _makeLimiter(key) {
    const cfg = this.harness.config.get(key) ?? {};
    // config uses {window_ms, max_requests}; RateLimiter takes {windowMs, max}
    return new RateLimiter({ windowMs: cfg.window_ms, max: cfg.max_requests });
  }

  async listen() {
    await this.harness.loadPlugins();
    this.server = http.createServer((req, res) => {
      this._handle(req, res).catch((err) => {
        log.error('request handler crash:', err.stack ?? err.message);
        if (!res.headersSent) {
          json(res, 500, { error: 'internal error' });
        } else {
          res.end();
        }
      });
    });
    this.server.on('clientError', (_err, socket) => {
      try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* gone */ }
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => resolve());
    });
    const address = this.server.address();
    this.actualPort = address.port;
    return { host: this.host, port: this.actualPort };
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
    await this.harness.shutdown();
  }

  // ---- request pipeline ----------------------------------------------------

  async _handle(req, res) {
    setSecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    try {
      // Health probe: no auth.
      if (pathname === '/health') return json(res, 200, { ok: true, name: 'reva', version: '1.0.0' });

      // Static assets (no auth: the PWA shell must load to show the login UI).
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        return this._routeStatic(req, res, pathname);
      }

      const ip = clientIp(req);
      const limited = this.apiRate.take(ip);
      if (!limited.allowed) throw new RateLimitError(limited.retryAfterMs);

      // Auth endpoints: rate limited separately (brute force protection).
      if (pathname.startsWith('/api/auth/')) {
        const authLimited = this.authRate.take(`${ip}:${pathname}`);
        if (!authLimited.allowed) throw new RateLimitError(authLimited.retryAfterMs);
        return await this._auth(req, res, pathname);
      }

      const actor = this._requireAuth(req);
      if (pathname.startsWith('/api/')) {
        return await this._api(req, res, pathname, url, actor);
      }

      json(res, 404, { error: 'not found' });
    } catch (err) {
      mapError(res, err);
    }
  }

  _requireAuth(req) {
    const header = req.headers.authorization ?? '';
    const match = header.match(/^Bearer\s+(.+)$/);
    if (match) {
      const session = this.harness.sessions.verify(match[1].trim());
      if (session) {
        const account = this.harness.accounts.get(session.username);
        return { ...session, role: account?.role ?? 'user' };
      }
      throw new AuthError('invalid or expired token', 'invalid_token');
    }
    if (this.allowAnonymous && isLoopback(clientIp(req))) {
      return { username: 'anonymous-local', role: 'admin', anonymous: true };
    }
    throw new AuthError('authentication required', 'no_token');
  }

  // ---- auth endpoints --------------------------------------------------------

  async _auth(req, res, pathname) {
    const body = await readJsonBody(req);
    if (pathname === '/api/auth/bootstrap') {
      if (this.harness.accounts.count > 0) {
        throw new AuthError('admin already exists; log in instead', 'already_bootstrapped');
      }
      const account = await this.harness.accounts.register(body.username, body.password);
      await this.harness.audit.record(account.username, 'auth.register', { bootstrap: true });
      return json(res, 201, { ok: true, account });
    }
    if (pathname === '/api/auth/login') {
      const account = await this.harness.accounts.login(body.username, body.password);
      const session = await this.harness.sessions.create(account.username, { roles: account.role });
      await this.harness.audit.record(account.username, 'auth.login.ok', { ip: clientIp(req) });
      return json(res, 200, { ok: true, token: session.token, expires_at: session.expires_at, account });
    }
    if (pathname === '/api/auth/logout') {
      const actor = this._requireAuth(req); // verify before revoking
      const header = req.headers.authorization ?? '';
      const token = header.replace(/^Bearer\s+/, '').trim();
      const revoked = await this.harness.sessions.revoke(token);
      await this.harness.audit.record(actor.username, 'auth.logout', {});
      return json(res, 200, { ok: revoked });
    }
    json(res, 404, { error: 'not found' });
  }

  // ---- API -------------------------------------------------------------------

  async _api(req, res, pathname, url, actor) {
    const h = this.harness;
    const method = req.method;

    // ----- me -----
    if (pathname === '/api/me' && method === 'GET') {
      return json(res, 200, { actor });
    }

    // ----- providers & keys -----
    if (pathname === '/api/providers' && method === 'GET') {
      const configured = {};
      for (const name of h.providers.providerNames()) {
        configured[name] = {
          kind: h.config.get(`providers.${name}.kind`),
          has_key: (() => { try { return h.providers.resolveApiKey !== undefined && h.providers.isConfigured(name); } catch { return false; } })(),
        };
      }
      const { PROVIDER_CATALOG } = await import('../providers/index.js');
      return json(res, 200, { catalog: PROVIDER_CATALOG, configured, default_provider: h.config.get('default_provider'), default_model: h.config.get('default_model') });
    }
    if (pathname === '/api/keys' && method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.provider !== 'string' || !h.providers.providerNames().includes(body.provider)) {
        return json(res, 400, { error: 'unknown provider' });
      }
      if (typeof body.key !== 'string' || body.key.length < 8 || body.key.length > 4096) {
        return json(res, 400, { error: 'key must be 8-4096 chars' });
      }
      if (!h.keystore.unlocked) return json(res, 409, { error: 'keystore locked — unlock or create it first', code: 'keystore_locked' });
      await h.keystore.setSecret(`provider:${body.provider}`, body.key);
      await h.audit.record(actor.username, 'keys.set', { provider: body.provider });
      return json(res, 200, { ok: true, provider: body.provider });
    }
    if (pathname.startsWith('/api/keys/') && method === 'DELETE') {
      const provider = pathname.slice('/api/keys/'.length);
      if (!h.keystore.unlocked) return json(res, 409, { error: 'keystore locked', code: 'keystore_locked' });
      const removed = await h.keystore.removeSecret(`provider:${provider}`);
      await h.audit.record(actor.username, 'keys.remove', { provider, removed });
      return json(res, 200, { ok: removed });
    }
    if (pathname === '/api/keystore' && method === 'GET') {
      return json(res, 200, h.keystore.sealed());
    }

    // ----- sessions -----
    if (pathname === '/api/sessions' && method === 'GET') {
      return json(res, 200, { sessions: h.sessionIndex.list() });
    }
    if (pathname === '/api/sessions' && method === 'POST') {
      const body = await readJsonBody(req);
      const session = h.createSession({
        provider: typeof body.provider === 'string' ? body.provider : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        mode: 'main',
      });
      session.markServerMode();
      await session._touch(); // register in the index before first message
      await h.audit.record(actor.username, 'session.create', { session: session.id });
      return json(res, 201, { id: session.id, provider: session.providerName, model: session.model });
    }
    let m = pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = m[1];
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') {
        const meta = h.sessionIndex.get(id);
        if (!meta) return json(res, 404, { error: 'session not found' });
        return json(res, 200, meta);
      }
      if (sub === '' && method === 'DELETE') {
        const running = this.runningRuns.get(id);
        running?.abort?.();
        this._cache?.delete(id);
        await h.audit.record(actor.username, 'session.delete', { session: id });
        return json(res, 200, { ok: true });
      }
      if (sub === '/abort' && method === 'POST') {
        const running = this.runningRuns.get(id);
        if (running) { running.abort(); return json(res, 200, { ok: true, aborted: true }); }
        return json(res, 200, { ok: true, aborted: false });
      }
      if (sub === '/events' && method === 'GET') {
        return this._sse(req, res, id, Number(url.searchParams.get('since') ?? -1));
      }
      if (sub === '/messages' && method === 'POST') {
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text : '';
        if (text.trim().length === 0) return json(res, 400, { error: 'text is required' });
        return this._runAgent(req, res, id, text, actor);
      }
    }

    // ----- skills / plugins / extensions / tools -----
    if (pathname === '/api/skills' && method === 'GET') {
      return json(res, 200, { skills: h.skills.list(), errors: h.skills.errors() });
    }
    if (pathname === '/api/plugins' && method === 'GET') {
      return json(res, 200, { plugins: h.plugins.list() });
    }
    if (pathname === '/api/extensions' && method === 'GET') {
      return json(res, 200, { extensions: h.extensions.list() });
    }
    if (pathname === '/api/tools' && method === 'GET') {
      return json(res, 200, { tools: h.tools.defsFor().map((d) => ({ name: d.name, description: d.description })) });
    }

    // ----- bots -----
    if (pathname === '/api/bots' && method === 'GET') {
      return json(res, 200, { bots: h.bots.list() });
    }
    m = pathname.match(/^\/api\/bots\/([^/]+)\/run$/);
    if (m && method === 'POST') {
      const body = await readJsonBody(req);
      const prompt = typeof body.prompt === 'string' ? body.prompt : '';
      if (prompt.trim().length === 0) return json(res, 400, { error: 'prompt is required' });
      const result = await h.runBot(decodeURIComponent(m[1]), prompt, { mode: 'server', signal: AbortSignal.timeout(120000) });
      return json(res, 200, { ok: true, text: result.text, usage: result.usage, iterations: result.iterations });
    }

    // ----- MCP -----
    if (pathname === '/api/mcp' && method === 'GET') {
      return json(res, 200, {
        configured: Object.keys(h.mcp.configuredServers()),
        status: h.mcp.status(),
        tools: h.mcp.allTools().map((t) => ({ name: t.name, description: t.description })),
      });
    }
    if (pathname === '/api/mcp/connect' && method === 'POST') {
      const body = await readJsonBody(req);
      const results = typeof body.server === 'string'
        ? { [body.server]: await wrapConnect(() => h.mcp.connect(body.server)) }
        : await h.connectMcpAll();
      return json(res, 200, { results });
    }

    // ----- memory -----
    if (pathname === '/api/memory' && method === 'GET') {
      const { MemoryManager } = await import('../agent/memory.js');
      const mem = new MemoryManager({ workspace: h.workspace, config: h.config });
      return json(res, 200, await mem.readAll());
    }
    if (pathname === '/api/memory' && method === 'POST') {
      const body = await readJsonBody(req);
      const { MemoryManager } = await import('../agent/memory.js');
      const mem = new MemoryManager({ workspace: h.workspace, config: h.config });
      await mem.writeTopic(String(body.topic ?? 'notes'), String(body.content ?? ''));
      await h.audit.record(actor.username, 'config.change', { memory_topic: body.topic });
      return json(res, 200, { ok: true });
    }

    // ----- automation -----
    if (pathname === '/api/automation' && method === 'GET') {
      return json(res, 200, { jobs: h.automation.list() });
    }
    if (pathname === '/api/automation' && method === 'POST') {
      const body = await readJsonBody(req);
      const job = await h.automation.add(body);
      h.startScheduler();
      await h.audit.record(actor.username, 'config.change', { automation_add: job.id });
      return json(res, 201, job);
    }
    m = pathname.match(/^\/api\/automation\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const ok = await h.automation.remove(decodeURIComponent(m[1]));
      return json(res, ok ? 200 : 404, { ok });
    }

    // ----- audit (admin only) -----
    if (pathname === '/api/audit' && method === 'GET') {
      if (actor.role !== 'admin') return json(res, 403, { error: 'admin only' });
      const verification = await h.audit.verify();
      return json(res, 200, {
        ok: verification.ok,
        total: verification.total,
        entries: verification.entries.slice(-200),
      });
    }

    // ----- settings (sanitized project config) -----
    if (pathname === '/api/settings' && method === 'GET') {
      const raw = structuredClone(h.config.raw());
      if (raw.providers) {
        for (const p of Object.values(raw.providers)) delete p.api_key;
      }
      return json(res, 200, raw);
    }

    json(res, 404, { error: 'not found' });
  }

  // ---- agent run over HTTP ---------------------------------------------------

  async _runAgent(req, res, sessionId, text, actor) {
    const h = this.harness;
    const existing = this.runningRuns.get(sessionId);
    if (existing && !existing.done) {
      return json(res, 409, { error: 'a run is already in progress for this session', code: 'busy' });
    }
    const session = await this._getSession(sessionId);
    if (!session) return json(res, 404, { error: 'session not found' });

    const controller = new AbortController();
    const entry = { abort: () => controller.abort(), done: false };
    const promise = session.run(text, { signal: controller.signal })
      .then((result) => ({ ok: true, ...result }))
      .catch((err) => ({ ok: false, error: err.message, aborted: err.name === 'AbortError' }))
      .finally(() => { entry.done = true; });

    entry.promise = promise;
    this.runningRuns.set(sessionId, entry);
    promise.then((r) => {
      if (!r.ok) {
        h.audit.record(actor.username, 'session.error', { session: sessionId, error: r.error }).catch(() => {});
      }
    });
    promise.finally(() => {
      if (this.runningRuns.get(sessionId) === entry) this.runningRuns.delete(sessionId);
    });

    // 202: events stream over SSE; the final result is emitted as an event.
    void promise;
    return json(res, 202, { accepted: true, session: sessionId });
  }

  // Memoize the LOADING PROMISE, not the session: two concurrent lookups
  // (SSE + message POST) must resolve to the same session object, or events
  // split across two instances and the stream goes silent.
  _getSession(id) {
    if (!this._cache) this._cache = new Map();
    if (!this._cache.has(id)) {
      const meta = this.harness.sessionIndex.get(id);
      if (!meta) return Promise.resolve(null);
      this._cache.set(id, (async () => {
        const session = this.harness.createSession({
          id,
          mode: 'main',
          provider: meta.provider,
          model: meta.model,
        });
        session.markServerMode();
        await session.loadHistory();
        return session;
      })());
    }
    return this._cache.get(id);
  }

  // ---- SSE ---------------------------------------------------------------------

  async _sse(req, res, sessionId, since) {
    const session = await this._getSession(sessionId);
    if (!session) return json(res, 404, { error: 'session not found' });
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event) => {
      try {
        res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch { /* closed */ }
    };
    for (const e of session.eventLog.all()) {
      if (e.seq > since) send(e);
    }
    const unsubscribe = session.eventLog.subscribe(send);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  // ---- static --------------------------------------------------------------------

  // Static routing is exact-match: request paths select among fixed constant
  // names, so no request-derived string ever reaches a filesystem call.
  // Unknown routes fall back to the SPA shell.
  async _routeStatic(req, res, pathname) {
    const extMatch = pathname.match(/^\/extensions\/([a-z0-9_-]+)$/i);
    if (extMatch) {
      // The request only names an extension (registry key); the served path
      // was computed server-side at load time.
      const resolved = await this.harness.extensions.resolveEntry(decodeURIComponent(extMatch[1]));
      if (!resolved) return json(res, 404, { error: 'extension file not found' });
      return this._sendFile(res, resolved.abs);
    }
    switch (pathname) {
      case '/':
      case '/index.html':
        return this._sendPublic(res, 'index.html');
      case '/app.css':
        return this._sendPublic(res, 'app.css');
      case '/app.js':
        return this._sendPublic(res, 'app.js');
      case '/sw.js':
        return this._sendPublic(res, 'sw.js');
      case '/manifest.webmanifest':
        return this._sendPublic(res, 'manifest.webmanifest');
      case '/icon.svg':
        return this._sendPublic(res, 'icon.svg');
      default:
        return this._sendPublic(res, 'index.html'); // SPA fallback
    }
  }

  _sendPublic(res, fixedName) {
    return this._sendFile(res, path.join(this.publicDir, fixedName));
  }

  _sendFile(res, abs) {
    const ext = path.extname(abs).toLowerCase();
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    const stream = fs.createReadStream(abs);
    stream.on('error', () => {
      if (!res.headersSent) json(res, 500, { error: 'read error' });
      else res.end();
    });
    stream.pipe(res);
  }
}

// ---- helpers -----------------------------------------------------------------

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('Cache-Control', 'no-store');
}

export function clientIp(req) {
  // Only socket address: we do not trust proxy headers by default (spoofable).
  return req.socket.remoteAddress ?? 'unknown';
}

function isLoopback(ip) {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

async function readJsonBody(req) {
  const max = 2 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  let overflow = false;
  // On overflow keep draining so the client gets a clean 413 response instead
  // of a mid-upload connection reset.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) { overflow = true; continue; }
    chunks.push(chunk);
  }
  if (overflow) {
    const err = new Error('request body too large');
    err.status = 413;
    throw err;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim().length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('JSON body must be an object');
    err.status = 400;
    throw err;
  }
  // depth guard
  const checkDepth = (v, d) => {
    if (d > 32) throw Object.assign(new Error('JSON body too deep'), { status: 400 });
    if (v && typeof v === 'object') {
      for (const x of Object.values(v)) checkDepth(x, d + 1);
    }
  };
  checkDepth(parsed, 0);
  return parsed;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

function mapError(res, err) {
  const status = err.status ?? err.statusCode ?? 500;
  const body = { error: status >= 500 ? 'internal error' : err.message };
  if (err.code) body.code = err.code;
  if (err.retryAfterMs) body.retry_after_ms = err.retryAfterMs;
  if (status >= 500) log.error('api error:', err.stack ?? err.message);
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err.retryAfterMs) res.setHeader('retry-after', String(Math.ceil(err.retryAfterMs / 1000)));
  json(res, status, body);
}

async function wrapConnect(fn) {
  try {
    const client = await fn();
    return { ok: true, tools: client.tools.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Readable is imported for potential SSE backpressure handling; keep reference.
void Readable;
