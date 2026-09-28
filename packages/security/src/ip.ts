import { BlockList, isIP } from 'node:net';

export type AddressClassification =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'unique_local'
  | 'cgnat'
  | 'multicast'
  | 'broadcast'
  | 'reserved'
  | 'documentation'
  | 'unspecified'
  | 'metadata'
  | 'benchmarking'
  | 'translation'
  | 'invalid';

type BlockedClassification = Exclude<AddressClassification, 'public' | 'invalid'>;

const IPV4_RANGES: readonly (readonly [string, number, BlockedClassification])[] = [
  ['169.254.169.254', 32, 'metadata'],
  ['100.100.100.200', 32, 'metadata'],
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'reserved'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.31.196.0', 24, 'reserved'],
  ['192.52.193.0', 24, 'reserved'],
  ['192.88.99.0', 24, 'reserved'],
  ['192.168.0.0', 16, 'private'],
  ['192.175.48.0', 24, 'reserved'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['255.255.255.255', 32, 'broadcast'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

const IPV6_RANGES: readonly (readonly [string, number, BlockedClassification])[] = [
  ['fd00:ec2::254', 128, 'metadata'],
  ['::', 128, 'unspecified'],
  ['::1', 128, 'loopback'],
  ['64:ff9b:1::', 48, 'translation'],
  ['100::', 64, 'reserved'],
  ['2001:2::', 48, 'benchmarking'],
  ['2001:10::', 28, 'reserved'],
  ['2001:20::', 28, 'reserved'],
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
  ['5f00::', 16, 'reserved'],
  ['fc00::', 7, 'unique_local'],
  ['fe80::', 10, 'link_local'],
  ['fec0::', 10, 'reserved'],
  ['ff00::', 8, 'multicast'],
];

interface ClassifiedRange {
  readonly list: BlockList;
  readonly classification: BlockedClassification;
}

function buildRanges(
  ranges: readonly (readonly [string, number, BlockedClassification])[],
  family: 'ipv4' | 'ipv6',
): ClassifiedRange[] {
  return ranges.map(([network, prefix, classification]) => {
    const list = new BlockList();
    list.addSubnet(network, prefix, family);
    return { list, classification };
  });
}

const V4 = buildRanges(IPV4_RANGES, 'ipv4');
const V6 = buildRanges(IPV6_RANGES, 'ipv6');

export function ipv6ToBytes(address: string): Uint8Array | null {
  if (isIP(address) !== 6) {
    return null;
  }
  let text = address.toLowerCase();
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const trailing = text.slice(lastColon + 1);
  if (trailing.includes('.')) {
    const octets = trailing.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    tail = [(a << 8) | b, (c << 8) | d];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const [head = '', rest] = text.split('::');
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const headGroups = parse(head);
  const restGroups = rest === undefined ? [] : parse(rest);
  const missing = 8 - headGroups.length - restGroups.length;
  const groups =
    rest === undefined
      ? headGroups
      : [...headGroups, ...Array<number>(Math.max(0, missing)).fill(0), ...restGroups];
  if (tail.length === 2) {
    groups.splice(6, 2, ...tail);
  }
  if (
    groups.length !== 8 ||
    groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)
  ) {
    return null;
  }
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

function bytesToIpv4(bytes: Uint8Array, offset: number, xorMask = 0): string {
  return Array.from(
    { length: 4 },
    (_, index) => ((bytes[offset + index] ?? 0) ^ xorMask) & 0xff,
  ).join('.');
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

export function embeddedIpv4(address: string): string | null {
  const bytes = ipv6ToBytes(address);
  if (bytes === null) {
    return null;
  }
  const zeros10 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (startsWith(bytes, [...zeros10, 0xff, 0xff])) {
    return bytesToIpv4(bytes, 12);
  }
  if (
    startsWith(bytes, [...zeros10, 0, 0]) &&
    !(bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && (bytes[15] ?? 0) <= 1)
  ) {
    return bytesToIpv4(bytes, 12);
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) {
    return bytesToIpv4(bytes, 12);
  }
  if (startsWith(bytes, [0x20, 0x02])) {
    return bytesToIpv4(bytes, 2);
  }
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00])) {
    return bytesToIpv4(bytes, 12, 0xff);
  }
  return null;
}

export function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export function classifyAddress(input: string): AddressClassification {
  const address = stripIpv6Brackets(input.trim());
  const family = isIP(address);
  if (family === 4) {
    return V4.find((range) => range.list.check(address, 'ipv4'))?.classification ?? 'public';
  }
  if (address.includes('%')) {
    return 'link_local';
  }
  if (family === 6) {
    const direct = V6.find((range) => range.list.check(address, 'ipv6'))?.classification;
    if (direct !== undefined) {
      return direct;
    }
    const embedded = embeddedIpv4(address);
    if (embedded !== null) {
      const inner = classifyAddress(embedded);
      return inner === 'public' ? 'public' : inner;
    }
    return 'public';
  }
  return 'invalid';
}

export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}

export function addressInCidrs(address: string, cidrs: readonly string[]): boolean {
  const normalized = stripIpv6Brackets(address);
  const family = isIP(normalized);
  if (family === 0 || cidrs.length === 0) {
    return false;
  }
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [network = '', prefixText = ''] = cidr.split('/');
    const networkFamily = isIP(network);
    const prefix = Number(prefixText);
    if (
      networkFamily === 0 ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > (networkFamily === 4 ? 32 : 128)
    ) {
      throw new RangeError(`invalid CIDR ${cidr}`);
    }
    list.addSubnet(network, prefix, networkFamily === 4 ? 'ipv4' : 'ipv6');
  }
  return list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}
