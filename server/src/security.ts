import { lookup as dnsLookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { findPlatform } from './platforms.js';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export function validateUrl(input: string, config: Pick<Config, 'allowedHosts'>): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiError(400, 'INVALID_URL', 'Enter a complete HTTPS media URL.'); }
  if (input.length > 4096 || url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new ApiError(400, 'INVALID_URL', 'Use an HTTPS link without credentials or a custom port.');
  }
  if (!config.allowedHosts.has(url.hostname)) {
    const platform = findPlatform(url.hostname);
    if (platform) throw new ApiError(422, 'PLATFORM_RESTRICTED', `${platform.name}: ${platform.description}`);
    throw new ApiError(422, 'HOST_NOT_ALLOWED', 'This source is not enabled. Use a direct media link from a supported source.');
  }
  url.hash = '';
  return url;
}

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address) || address.includes('%')) return false;
  const parsed = ipaddr.parse(address);
  // IPv4-mapped IPv6, NAT64, 6to4, Teredo and other transition addresses are
  // deliberately rejected rather than relying on a downstream routing policy.
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') {
    const denied = ['168.63.129.16/32', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24'];
    return !denied.some(cidr => parsed.match(ipaddr.parseCIDR(cidr) as [ipaddr.IPv4, number]));
  }
  const v6 = parsed as ipaddr.IPv6;
  return v6.match(ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number]) &&
    !['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20'].some(cidr => v6.match(ipaddr.parseCIDR(cidr) as [ipaddr.IPv6, number]));
}

const defaultLookup: Lookup = async hostname => {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
};

export async function resolvePublicAddress(hostname: string, lookup: Lookup = defaultLookup): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[];
  try { addresses = await lookup(hostname); }
  catch { throw new ApiError(502, 'DNS_FAILED', 'The source domain could not be resolved. Please try again.'); }
  // Reject the entire answer set if even one record is non-public. Never retry
  // through an unchecked DNS answer after a connection failure.
  if (!addresses.length || addresses.some(record => ![4, 6].includes(record.family) || !isPublicAddress(record.address))) {
    throw new ApiError(403, 'UNSAFE_SOURCE', 'The source address is not permitted.');
  }
  return addresses.find(record => record.family === 4) ?? addresses[0];
}

export function parseByteRange(value: string | undefined, size?: number): string | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ApiError(416, 'INVALID_RANGE', 'A single valid byte range is required.');
  const start = match[1] ? Number(match[1]) : undefined;
  const end = match[2] ? Number(match[2]) : undefined;
  if ([start, end].some(x => x !== undefined && (!Number.isSafeInteger(x) || x < 0)) ||
      (start !== undefined && end !== undefined && end < start) ||
      (start === undefined && end === 0) || (size !== undefined && start !== undefined && start >= size)) {
    throw new ApiError(416, 'INVALID_RANGE', 'The requested media range is unavailable.');
  }
  return value;
}
