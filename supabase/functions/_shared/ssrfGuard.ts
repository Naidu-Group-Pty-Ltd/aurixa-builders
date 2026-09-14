/**
 * SSRF guard — refuse a URL that resolves to a private or reserved address.
 *
 * `assertPublicUrl` is called on EVERY redirect hop, not just the first, so a
 * public host that 302s to 169.254.169.254 is still refused.
 *
 * ## One copy, here
 *
 * There were two: this file and a byte-identical `import-from-url/ssrfGuard.ts`.
 * Three functions imported this one and `_shared/builderStock/fetchSource.ts`
 * imported the other — across a function directory, which no bundle contains,
 * so the three builder-stock functions could not be deployed to a clone at
 * all. Two copies of a security check is also how one gets hardened and the
 * other does not, with no way to tell from a call site which you got.
 *
 * `import-from-url` — the function the duplicate was named for — CALLED
 * `assertPublicUrl` while importing it from nowhere, so its guard threw
 * ReferenceError on every hop rather than checking anything. That is why the
 * identifier sat in `functions-registry/edge-missing-names.txt`.
 */
export type DnsRecordType = 'A' | 'AAAA';
export type DnsResolver = (hostname: string, recordType: DnsRecordType) => Promise<string[]>;

function ipv4Number(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function mappedIpv4(address: string): string | null {
  const normalized = address.toLowerCase().split('%')[0];
  const dotted = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

/** Fail closed for every non-globally-routable IPv4/IPv6 destination. */
export function isPrivateOrReservedAddress(address: string): boolean {
  const clean = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = mappedIpv4(clean);
  if (mapped) return isPrivateOrReservedAddress(mapped);

  const ipv4 = ipv4Number(clean);
  if (ipv4 !== null) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, prefix]) => inIpv4Range(ipv4, base as string, prefix as number));
  }

  if (!clean.includes(':')) return true;
  // Currently allocated global-unicast IPv6 space is 2000::/3. Everything else
  // includes unspecified, loopback, mapped, link-local, ULA, and multicast space.
  const firstHextet = Number.parseInt(clean.split(':')[0] || '0', 16);
  return !Number.isFinite(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff;
}

function isLiteralAddress(hostname: string): boolean {
  return ipv4Number(hostname) !== null || hostname.includes(':');
}

export async function assertPublicUrl(rawUrl: string, resolveDns: DnsResolver): Promise<URL> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed');

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') ||
      hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    throw new Error('Refusing to fetch a private/internal address');
  }

  let addresses: string[];
  if (isLiteralAddress(hostname)) {
    addresses = [hostname];
  } else {
    const results = await Promise.allSettled([resolveDns(hostname, 'A'), resolveDns(hostname, 'AAAA')]);
    addresses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    if (addresses.length === 0) throw new Error('Unable to resolve source host');
  }
  if (addresses.some(isPrivateOrReservedAddress)) {
    throw new Error('Refusing to fetch a private/internal address');
  }
  return url;
}
