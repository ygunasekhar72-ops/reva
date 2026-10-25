// Web tools: web_search (DuckDuckGo HTML endpoint — no key needed; optional
// Brave/Tavily when the user configures a key) and web_fetch (SSRF-guarded,
// size-capped, HTML-to-text). Both audit-logged.
import { guardUrl } from '../security/ssrf.js';
import { isValidUrl, truncate } from '../util/text.js';

export const webSearchTool = {
  name: 'web_search',
  description: 'Search the public web and return ranked results (title, URL, snippet). No API key required.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'number', description: 'Max results, 1-10 (default 5)' },
    },
    required: ['query'],
  },
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (query.length === 0) throw new Error('query must not be empty');
    if (query.length > 400) throw new Error('query too long');
    const max = Math.min(10, Math.max(1, args.max_results ?? 5));

    ctx.emit?.({ type: 'web_search', query });
    if (ctx.audit) await ctx.audit.record(ctx.session?.actor ?? 'agent', 'web.search', { query });

    const braveKey = ctx.keystore?.unlocked ? ctx.keystore.getSecret('search:brave') : undefined;
    const tavilyKey = ctx.keystore?.unlocked ? ctx.keystore.getSecret('search:tavily') : undefined;
    if (braveKey) return braveSearch(query, max, braveKey);
    if (tavilyKey) return tavilySearch(query, max, tavilyKey);
    return ddgSearch(query, max);
  },
};

// ---- DuckDuckGo HTML (html.duckduckgo.com/html/?q=...) ---------------------
// Result markup: <a class="result__a" href="...">title</a>
//   <a class="result__snippet" ...>snippet</a>
export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const titles = [];
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    titles.push({ href: decodeEntities(m[1]), title: stripTags(m[2]) });
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(m[1]));
  }
  for (let i = 0; i < titles.length; i++) {
    let href = titles[i].href;
    // DDG wraps outbound links: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { href = decodeURIComponent(uddg[1]); } catch { /* keep raw */ }
    }
    if (!isValidUrl(href)) continue;
    results.push({
      title: titles[i].title || '(untitled)',
      url: href,
      snippet: truncate(snippets[i] ?? '', 300),
    });
  }
  return results;
}

async function ddgSearch(query, max) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      accept: 'text/html',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`search backend returned HTTP ${response.status}`);
  }
  const html = await response.text();
  const results = parseDuckDuckGoHtml(html).slice(0, max);
  if (results.length === 0) return { text: '(no results found)', results: [] };
  return {
    text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n'),
    results,
  };
}

// ---- Brave / Tavily (optional, user-provided keys) -------------------------

async function braveSearch(query, max, key) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(max));
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'x-subscription-token': key },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`brave search HTTP ${response.status}`);
  const json = await response.json();
  const results = (json.web?.results ?? []).slice(0, max).map((r) => ({
    title: r.title, url: r.url, snippet: truncate(r.description ?? '', 300),
  }));
  return {
    text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') || '(no results)',
    results,
  };
}

async function tavilySearch(query, max, key) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: max }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`tavily search HTTP ${response.status}`);
  const json = await response.json();
  const results = (json.results ?? []).slice(0, max).map((r) => ({
    title: r.title, url: r.url, snippet: truncate(r.content ?? '', 300),
  }));
  return {
    text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n') || '(no results)',
    results,
  };
}

// ---- web_fetch ---------------------------------------------------------------

export const webFetchTool = {
  name: 'web_fetch',
  description: 'Fetch a URL over HTTP(S) and return its content as text (HTML converted to readable text, JSON passed through). Private/internal addresses are blocked by the SSRF guard.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL' },
      max_bytes: { type: 'number', description: 'Max response bytes (default from config)' },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    const webCfg = ctx.config?.get('tools.web') ?? {};
    const policy = {
      allowPrivate: webCfg.allow_private_addresses === true,
      allowedHosts: webCfg.allowed_hosts ?? [],
      blockedHosts: webCfg.blocked_hosts ?? [],
    };
    let currentUrl = await guardUrl(args.url, policy);
    const maxBytes = Math.min(5 * 1024 * 1024, args.max_bytes ?? webCfg.max_bytes ?? 2 * 1024 * 1024);

    ctx.emit?.({ type: 'web_fetch', url: currentUrl.toString() });
    if (ctx.audit) await ctx.audit.record(ctx.session?.actor ?? 'agent', 'web.fetch', { url: currentUrl.toString() });

    // Manual redirect handling: every hop is re-validated through the full
    // SSRF policy, so a public URL cannot bounce the fetch to a private or
    // metadata address behind the guard.
    const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
    let response;
    let hops = 0;
    for (;;) {
      response = await fetch(currentUrl, {
        headers: {
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 REVA/1.0',
          accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
      });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* socket already gone */ }
      if (!location) break;
      hops += 1;
      if (hops > 5) {
        throw new Error(`too many redirects (>${5}) fetching ${currentUrl.host}${currentUrl.pathname}`);
      }
      currentUrl = await guardUrl(new URL(location, currentUrl).toString(), policy);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${currentUrl.host}${currentUrl.pathname}`);
    }
    const contentType = response.headers.get('content-type') ?? '';

    // Bounded body read: the byte budget is enforced during the download
    // (decompressed), not after it — a huge or gzip-expanded body can never
    // be fully materialized in memory.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        try { await reader.cancel(); } catch { /* stream already closed */ }
        break;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);
    const text = buf.toString('utf8');

    let body;
    if (contentType.includes('application/json')) {
      body = text;
    } else if (contentType.includes('text/html') || /<html[\s>]/i.test(text)) {
      body = htmlToText(text);
    } else {
      body = text;
    }
    return {
      text: `${truncate(body, 12000)}${truncated ? '\n[truncated]' : ''}`,
      url: currentUrl.toString(),
      content_type: contentType,
      bytes: total,
      truncated,
      redirects: hops,
    };
  },
};

// ---- HTML → text (dependency-free) ----------------------------------------

export function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

export function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decodeEntities(l).replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .slice(0, 400000);
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = parseInt(n, 16);
      return code > 0 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    });
}
