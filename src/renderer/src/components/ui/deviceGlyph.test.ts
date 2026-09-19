import assert from 'node:assert/strict'

// deviceGlyphFor — the ONE implementation of "which device glyph does this
// machine get?" (design-system/components/glyphs → Device identity).
//
// The rule is a guess about a NAME, and one clause is a trap: "MacBook Pro"
// satisfies both halves of the macOS-desktop test, so the `book` exclusion is
// the only thing keeping a laptop off the Mac mini glyph. These assertions are
// the reason the rule is a function rather than a switch at each call site.

async function main(): Promise<void> {
  const { deviceGlyphFor } = await import('./deviceGlyph')
  const { DeviceDesktopGlyph, DeviceLaptopGlyph, DeviceMacGlyph, DevicePhoneGlyph, RemoteMachineGlyph } =
    await import('../AppIcons')

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  run('a macOS desktop is named like one', () => {
    for (const hostName of ['Office-Mac-mini', 'IMAC-OFFICE', 'Mac-Studio-01', 'mac-pro']) {
      assert.equal(deviceGlyphFor({ os: 'macOS', hostName }), DeviceMacGlyph, `${hostName} should draw the flat box`)
    }
  })

  run('"book" beats every desktop hint — this is the clause that gets re-derived backwards', () => {
    assert.equal(
      deviceGlyphFor({ os: 'darwin', hostName: 'Dev-MacBook-Pro' }),
      DeviceLaptopGlyph,
      'a MacBook Pro contains "pro" and is still a laptop',
    )
    assert.equal(deviceGlyphFor({ os: 'macOS', hostName: 'Dev-MacBook-Air' }), DeviceLaptopGlyph)
  })

  run('windows and linux take the monitor, and "darwin" does not fall into "win"', () => {
    assert.equal(deviceGlyphFor({ os: 'win32', hostName: 'DESKTOP-A1B2C3D' }), DeviceDesktopGlyph)
    assert.equal(deviceGlyphFor({ os: 'Windows', hostName: 'DESKTOP-E4F5G6H' }), DeviceDesktopGlyph)
    assert.equal(deviceGlyphFor({ os: 'linux', hostName: 'build-box' }), DeviceDesktopGlyph)
    assert.notEqual(
      deviceGlyphFor({ os: 'darwin', hostName: 'Office-Mac-mini' }),
      DeviceDesktopGlyph,
      '"darwin" contains "win"; the macOS branch has to return first',
    )
  })

  run('phones take the phone', () => {
    assert.equal(deviceGlyphFor({ os: 'android', hostName: 'pixel-8' }), DevicePhoneGlyph)
    assert.equal(deviceGlyphFor({ os: 'iOS', hostName: 'dev-iphone' }), DevicePhoneGlyph)
  })

  run('an unknown machine still gets a mark, never an empty slot', () => {
    assert.equal(deviceGlyphFor({ os: undefined, hostName: 'unknown-1' }), RemoteMachineGlyph)
    assert.equal(deviceGlyphFor({ os: null, hostName: null }), RemoteMachineGlyph)
    assert.equal(deviceGlyphFor({ os: 'freebsd', hostName: 'nas' }), RemoteMachineGlyph)
    assert.equal(
      deviceGlyphFor({ os: 'macOS', hostName: 'office-machine' }),
      RemoteMachineGlyph,
      'a Mac whose name says neither is not guessed at — the fallback is honest',
    )
  })

  run('it returns the COMPONENT, so the caller keeps size and ink', () => {
    const Glyph = deviceGlyphFor({ os: 'macOS', hostName: 'Office-Mac-mini' })
    assert.equal(typeof Glyph, 'function', 'a component, not a rendered element')
  })

  if (failures > 0) {
    console.error(`\ndeviceGlyph.test.ts: ${failures} failing`)
    process.exit(1)
  }
  console.log('deviceGlyph: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
