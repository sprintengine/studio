import assert from 'node:assert/strict'
import type { NetworkInterfaceInfo } from 'node:os'
import { test } from 'vitest'

import { isInsideWsl, resolveTailnetInterface } from './tailnet-interface'

test('a process knows it is inside WSL by its distribution name or the interop entry, and only on Linux', () => {
  const none = () => false
  assert.equal(isInsideWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, exists: none }), true)
  assert.equal(
    isInsideWsl({ platform: 'linux', env: {}, exists: (path) => path === '/proc/sys/fs/binfmt_misc/WSLInterop' }),
    true,
  )
  assert.equal(isInsideWsl({ platform: 'linux', env: {}, exists: none }), false)
  assert.equal(isInsideWsl({ platform: 'win32', env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' }, exists: none }), false)
  assert.equal(isInsideWsl({ platform: 'darwin', env: {}, exists: () => true }), false)
})

// Interface fixtures in the shape `os.networkInterfaces()` returns. A macOS
// utun carries a link-local fe80:: beside whatever the tunnel assigned.
function entry(address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4'
  return {
    address,
    netmask: family === 'IPv4' ? '255.255.255.255' : 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    family,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
    ...extra,
  } as NetworkInterfaceInfo
}

const lan = { en0: [entry('192.168.1.20'), entry('fe80::1c2b:3d4e:5f60:7182%en0')] }
const warp = { utun3: [entry('fe80::aa1:2b3c:4d5e:6f70%utun3'), entry('100.96.0.12')] }
const tailscaleUtun = {
  utun5: [entry('fe80::bb2:3c4d:5e6f:7081%utun5'), entry('100.101.102.103'), entry('fd7a:115c:a1e0::6a01:1f2b')],
}

test('a WARP tunnel alone is not a tailnet interface, though its address is in 100.64/10', () => {
  assert.equal(resolveTailnetInterface({ lo0: [entry('127.0.0.1', { internal: true })], ...lan, ...warp }), null)
})

test('with WARP and Tailscale both up, the utun carrying the fd7a address is picked whichever is listed first', () => {
  const expected = { address: '100.101.102.103', family: 'IPv4', interfaceName: 'utun5' }
  assert.deepEqual(resolveTailnetInterface({ ...lan, ...warp, ...tailscaleUtun }), expected)
  assert.deepEqual(resolveTailnetInterface({ ...tailscaleUtun, ...warp, ...lan }), expected)
})

test("Linux's tailscale0 qualifies by its name", () => {
  assert.deepEqual(resolveTailnetInterface({ eth0: [entry('10.0.0.4')], tailscale0: [entry('100.80.1.2')] }), {
    address: '100.80.1.2',
    family: 'IPv4',
    interfaceName: 'tailscale0',
  })
})

test("Windows' Tailscale adapter qualifies by its name, ahead of a CGNAT address on the uplink", () => {
  assert.deepEqual(resolveTailnetInterface({ 'Wi-Fi': [entry('100.72.9.40')], Tailscale: [entry('100.90.4.5')] }), {
    address: '100.90.4.5',
    family: 'IPv4',
    interfaceName: 'Tailscale',
  })
})

test('an IPv6-only tailnet interface yields its fd7a address, never the link-local one or a VPN address', () => {
  assert.deepEqual(
    resolveTailnetInterface({
      ...warp,
      utun6: [entry('fe80::cc3:4d5e:6f70:8192%utun6'), entry('fd7a:115c:a1e0::77%utun6')],
    }),
    { address: 'fd7a:115c:a1e0::77', family: 'IPv6', interfaceName: 'utun6' },
  )
})
