import React from 'react'
import type {
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
} from '../../types/workspace'
import {
  getSprintEngineRoleAccent,
  getSprintEngineRoleLabel,
  hexToRgba,
} from '../../utils/sprintengine'
import { SprintEngineRoleIcon } from '../AppIcons'

// RoleAvatar — disc-shaped avatar tinted in the role's accent colour with
// the role's glyph centered inside. The documented brand exception for
// role colour applies here: this is one of the four places per
// knowledge/brand/panel-design-system.md where role tone is allowed
// outside the panel-header identity dot.
//
// Sister primitive to RoleGlyph (which renders just the bare-tone glyph
// with no backplate). Use RoleAvatar when the surface needs the
// "agent identity disc" rhythm — roster rows, running-agents lists,
// add-member chips, spawn-dialog headers. Use RoleGlyph when a single
// inline glyph is enough — kanban-card trailing slot, task-graph node
// label.

type RoleAvatarSize = 'xs' | 'sm' | 'md'

const SIZE: Record<RoleAvatarSize, { disc: string; icon: string; alpha: number }> = {
  // Inline chips (e.g. "+ Add architect" buttons). Quieter background so it
  // doesn't read as a status badge.
  xs: { disc: 'h-4 w-4', icon: 'icon-xs', alpha: 0.14 },
  // Compact row avatars (dialog headers, dense rosters).
  sm: { disc: 'h-6 w-6', icon: 'icon-sm', alpha: 0.18 },
  // Standard roster / running-agents row avatar.
  md: { disc: 'h-7 w-7', icon: 'icon-md', alpha: 0.18 },
}

type RoleAvatarProps = {
  role: SprintEngineRoleId
  size?: RoleAvatarSize
  /** Optional class extras (margins, alignment). Don't pass colour or sizing
   *  — the primitive owns both. */
  className?: string
  /** Accessible name override. Defaults to `Role: <label>`. Pass an empty
   *  string when the avatar sits in a row whose label already announces
   *  the role; the disc becomes `aria-hidden`. */
  ariaLabel?: string
  /** Optional registry metadata so custom/configured roles render with a
   *  registry label and glyph. When omitted, custom roles use a humanized
   *  fallback label and a neutral disc glyph instead of indexing the
   *  static bundled-role maps. */
  registry?: SprintEngineRoleRegistry | SprintEngineRoleRegistryMetadata | null
}

export function RoleAvatar({ role, size = 'md', className, ariaLabel, registry }: RoleAvatarProps) {
  const { disc, icon, alpha } = SIZE[size]
  const accent = getSprintEngineRoleAccent(role, registry)
  const label = ariaLabel ?? `Role: ${getSprintEngineRoleLabel(role, registry)}`
  const hidden = ariaLabel === ''
  return (
    <span
      className={[
        'flex shrink-0 items-center justify-center rounded-full',
        disc,
        className ?? '',
      ]
        .filter(Boolean)
        .join(' ')}
      // design-tokens-allow: role avatar is the documented exception to the
      // one-accent rule; see knowledge/brand/panel-design-system.md.
      style={{ backgroundColor: hexToRgba(accent, alpha), color: accent }}
      role={hidden ? undefined : 'img'}
      aria-label={hidden ? undefined : label}
      aria-hidden={hidden ? true : undefined}
    >
      <SprintEngineRoleIcon role={role} registry={registry} className={icon} />
    </span>
  )
}
