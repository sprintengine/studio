// deviceGlyphFor — the ONE implementation of "which device glyph does this
// machine get?".
//
// Spec: design-system/components/glyphs/component.md → "Device identity", where
// the five numbered rules below are the normative copy.
//
// It exists as a function rather than as a `switch` at each call site because
// the rule is a guess about a NAME and one of its clauses is a trap:
// "MacBook Pro" satisfies both halves of the macOS-desktop test — it is macOS
// and it contains `pro` — so the `book` exclusion is what keeps a laptop from
// drawing as a Mac mini. A rule re-derived per surface gets that backwards on
// one of them, and the two surfaces that need it (the Machines list and the
// pair-request card) would then disagree about the same machine.
//
// The fallback is a real mark, not an empty slot: a machine whose name says
// nothing is still a machine.

import {
  DeviceDesktopGlyph,
  DeviceLaptopGlyph,
  DeviceMacGlyph,
  DevicePhoneGlyph,
  RemoteMachineGlyph,
} from '../AppIcons'

export type DeviceGlyphComponent = (props: { className?: string }) => JSX.Element

/** The host-name tokens that make a macOS machine a DESKTOP rather than a laptop. */
const MAC_DESKTOP_HINTS = ['mini', 'imac', 'studio', 'pro'] as const

/** The one token that overrides every hint above. "MacBook Pro" is a laptop. */
const MAC_LAPTOP_HINT = 'book'

export type DeviceGlyphInput = {
  /**
   * The machine's OS as the peer reported it — `darwin`, `macOS`, `win32`,
   * `Windows`, `linux`, `android`, `ios`. Matched case-insensitively on a
   * substring, because the four sources that feed the Machines list each spell
   * it their own way and none of them is authoritative.
   */
  os?: string | null
  /** The Tailscale host name (`Dev-MacBook-Air`, `DESKTOP-A1B2C3D`). */
  hostName?: string | null
}

/**
 * Returns the glyph COMPONENT, not an element: the caller owns the size and the
 * ink (`className`), which is what the glyphs entry requires of every family.
 *
 * The rule, in order — the first match wins:
 *
 * 1. macOS whose host name says desktop (`mini` / `imac` / `studio` / `pro`)
 *    and does NOT say `book` → `DeviceMacGlyph`.
 * 2. macOS whose host name says `book` → `DeviceLaptopGlyph`.
 * 3. Windows or Linux → `DeviceDesktopGlyph`.
 * 4. Android or iOS → `DevicePhoneGlyph`.
 * 5. Anything else, an unknown OS, or no OS at all → `RemoteMachineGlyph`.
 *
 * Rule 2 is deliberately separate from rule 5 rather than folded into it: a Mac
 * that says `book` is a laptop even when nothing else about it is known, and
 * leaving that to the fallback would draw a server rack for the most common
 * machine on a personal tailnet.
 */
export function deviceGlyphFor({ os, hostName }: DeviceGlyphInput): DeviceGlyphComponent {
  const platform = (os ?? '').toLowerCase()
  const name = (hostName ?? '').toLowerCase()

  // `ios` is a substring of nothing else here, but `darwin`/`mac` must be
  // tested before it so "macOS" never falls through to the phone branch.
  const isMac = platform.includes('mac') || platform.includes('darwin') || platform.includes('osx')

  if (isMac) {
    const saysLaptop = name.includes(MAC_LAPTOP_HINT)
    if (saysLaptop) return DeviceLaptopGlyph
    if (MAC_DESKTOP_HINTS.some((hint) => name.includes(hint))) return DeviceMacGlyph
    // A Mac whose name says neither is not guessed at. The fallback is honest,
    // and this list has enough rows that a wrong shape is worse than a neutral
    // one.
    return RemoteMachineGlyph
  }

  // NOTE the order: 'darwin' contains 'win'. The macOS branch above returns
  // first, which is the only thing keeping a Mac off the desktop glyph.
  if (platform.includes('win') || platform.includes('linux')) return DeviceDesktopGlyph
  if (platform.includes('android') || platform.includes('ios') || platform.includes('iphone')) {
    return DevicePhoneGlyph
  }

  return RemoteMachineGlyph
}
