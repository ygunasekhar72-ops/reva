// SSRF guard for the web tools. Resolves hostnames and refuses requests whose
// target IP is private, loopback, link-local, or otherwise non-public, unless
// explicitly allowed by config (needed for local dev and tests).
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class SSRFError extends Error {
  constructor(message, host) {
    super(message);
    this.code = 'ESSRF';
    this.host = host;
    this.status = 403;
  }
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127) return true;                        // private, loopback
    if (a === 0) return true;                                      // this-network
    if (a === 169 && b === 254) return true;                       // link-local (cloud metadata!)
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                       // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
    if (a >= 224) return true;                                     // multicast/reserved
    return false;
  }
  const lower = String(ip).toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true;                       // link-local v6
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true;                         // multicast
  // IPv4-mapped IPv6 (::ffff:10.0.0.1)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

function isLiteralHost(host) {
  return net.isIP(host) === 4 || net.isIP(host) === 6
    || /^(localhost|ip6-localhost|ip6-loopback)$/i.test(host);
}

// Validates a URL for fetching. Returns the normalized URL.
// opts: { allowPrivate, allowedHosts, blockedHosts }
export async function guardUrl(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new SSRFError('invalid URL', rawUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SSRFError(`scheme ${url.protocol} not allowed`, rawUrl);
  }
  if (url.username || url.password) {
    throw new SSRFError('credentials in URL not allowed', rawUrl);
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if ((opts.blockedHosts ?? []).some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`))) {
    throw new SSRFError(`host ${host} is blocked by policy`, host);
  }
  const allowListed = (opts.allowedHosts ?? []).some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
  const allowPrivate = opts.allowPrivate === true;

  if (!allowPrivate && !allowListed) {
    const ips = await resolveHost(host);
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new SSRFError(`host ${host} resolves to a private address (${ip})`, host);
      }
    }
  }
  return url;
}

async function resolveHost(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
  if (host.includes(':') && net.isIPv6(host)) return [host];
  if (/^localhost$/i.test(host)) return ['127.0.0.1', '::1'];
  try {
    const v4 = await lookup(host, { all: true, family: 4 }).catch(() => []);
    const v6 = await lookup(host, { all: true, family: 6 }).catch(() => []);
    const all = [...v4, ...v6].map((r) => r.address);
    if (all.length === 0) {
      // Unresolvable host: fail closed. Nothing legitimate is lost (fetch
      // could not connect either), and exotic DNS tricks are refused.
      return ['0.0.0.0'];
    }
    return all;
  } catch {
    return ['0.0.0.1'];
  }
}

// Post-connect safety net: some platforms resolve lazily. Call with the
// address fetch actually connected to when available.
export function assertPublicConnected(address, host) {
  if (isPrivateIp(address)) {
    throw new SSRFError(`connection to private address ${address} blocked (${host})`, host);
  }
}
