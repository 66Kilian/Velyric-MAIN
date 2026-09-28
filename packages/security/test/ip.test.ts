import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addressInCidrs,
  classifyAddress,
  embeddedIpv4,
  ipv6ToBytes,
  isPublicAddress,
} from '../src/ip.js';

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.20.30.40', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'metadata'],
    ['100.100.100.200', 'metadata'],
    ['169.254.10.10', 'link_local'],
    ['100.64.0.1', 'cgnat'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['192.0.2.10', 'documentation'],
    ['198.18.5.5', 'benchmarking'],
    ['224.0.0.251', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['fe80::1', 'link_local'],
    ['fe80::1%eth0', 'link_local'],
    ['fc00::1', 'unique_local'],
    ['fd12:3456:789a::1', 'unique_local'],
    ['fd00:ec2::254', 'metadata'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:a9fe:a9fe', 'metadata'],
    ['::127.0.0.1', 'loopback'],
    ['64:ff9b::a9fe:a9fe', 'metadata'],
    ['64:ff9b::808:808', 'public'],
    ['64:ff9b:1::1', 'translation'],
    ['2002:c0a8:0101::1', 'private'],
    ['2002:0808:0808::1', 'public'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'documentation'],
    ['2001:4860:4860::8888', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['not-an-ip', 'invalid'],
    ['', 'invalid'],
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('treats only public addresses as public', () => {
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('10.0.0.1')).toBe(false);
  });

  it('classifies every address in 10.0.0.0/8 as private and mapped IPv6 identically to IPv4', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        (b, c, d) => {
          const v4 = `10.${String(b)}.${String(c)}.${String(d)}`;
          expect(classifyAddress(v4)).toBe('private');
          expect(classifyAddress(`::ffff:${v4}`)).toBe('private');
        },
      ),
    );
    fc.assert(
      fc.property(fc.ipV4(), (v4) => {
        expect(classifyAddress(`::ffff:${v4}`)).toBe(classifyAddress(v4));
      }),
    );
  });
});

describe('IPv6 helpers', () => {
  it('expands compressed addresses', () => {
    expect(Array.from(ipv6ToBytes('::1') ?? [])).toEqual([...Array<number>(15).fill(0), 1]);
    expect(ipv6ToBytes('2001:db8::ff00:42:8329')?.[15]).toBe(0x29);
    expect(ipv6ToBytes('1.2.3.4')).toBeNull();
  });

  it('extracts embedded IPv4 addresses', () => {
    expect(embeddedIpv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(embeddedIpv4('64:ff9b::c000:0201')).toBe('192.0.2.1');
    expect(embeddedIpv4('2002:0a00:0001::')).toBe('10.0.0.1');
    expect(embeddedIpv4('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe('192.0.2.45');
    expect(embeddedIpv4('2606:4700::1')).toBeNull();
  });

  it('matches CIDR lists and rejects malformed CIDRs', () => {
    expect(addressInCidrs('127.0.0.1', ['127.0.0.1/32'])).toBe(true);
    expect(addressInCidrs('127.0.0.2', ['127.0.0.1/32'])).toBe(false);
    expect(addressInCidrs('fd00::5', ['fd00::/8'])).toBe(true);
    expect(addressInCidrs('10.0.0.1', [])).toBe(false);
    expect(() => addressInCidrs('10.0.0.1', ['10.0.0.0/33'])).toThrow(RangeError);
  });
});
