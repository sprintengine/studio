// Shared RoleGlyph primitive. The documented exception to the
// one-accent rule: this is the single place where role/tool tone is allowed
// to appear on a card (kanban roster cards, task-graph nodes, agent rows).
// See knowledge/brand/panel-design-system.md and
// knowledge/brand/aesthetic-north-star.md for the contract.
//
// The role tone source-of-truth is sprintEngineRoleAccent in
// src/renderer/src/utils/sprintengine.ts. Do not re-define role colors
// here; consume the safe accessors (getSprintEngineRoleLabel,
// getSprintEngineRoleAccent) so registry-keyed custom roles fall back
// cleanly instead of indexing static bundled-role maps.
//
// RoleGlyph never bleeds outside the kanban card it is documented for —
// panel chrome, list rows, headers, and inspector sections do not adopt
// role tone. Status and selection stay on --accent-primary + --tone-*.
import React from 'react'
import type {
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
} from '../../types/workspace'
import { getSprintEngineRoleAccent, getSprintEngineRoleLabel } from '../../utils/sprintengine'
import { SprintEngineRoleIcon } from '../AppIcons'

type RoleGlyphSize = 'sm' | 'md' | 'lg'

const SIZE_CLASS: Record<RoleGlyphSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
  lg: 'h-4 w-4',
}

type RoleGlyphProps = {
  role: SprintEngineRoleId
  size?: RoleGlyphSize
  /** Override the auto-generated "Role: <label>" accessible name. */
  ariaLabel?: string
  className?: string
  /** Optional registry metadata so custom/configured roles render with a
   *  registry label and accent. When omitted, custom roles use a humanized
   *  fallback label and the neutral chrome accent. */
  registry?: SprintEngineRoleRegistry | SprintEngineRoleRegistryMetadata | null
}

export function RoleGlyph({ role, size = 'md', ariaLabel, className, registry }: RoleGlyphProps) {
  const label = ariaLabel ?? `Role: ${getSprintEngineRoleLabel(role, registry)}`
  return (
    <span
      role="img"
      aria-label={label}
      // design-tokens-allow: role glyph is the documented exception to the one-accent
      // rule; see knowledge/brand/panel-design-system.md.
      style={{ color: getSprintEngineRoleAccent(role, registry) }}
      className={['inline-flex shrink-0 items-center justify-center', className ?? ''].join(' ')}
    >
      <SprintEngineRoleIcon role={role} registry={registry} className={SIZE_CLASS[size]} />
    </span>
  )
}
