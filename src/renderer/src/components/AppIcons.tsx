import { useState } from 'react'
import { SprintEngineFrond } from './brand/SprintEngineFrond'
import type { ModuleEnablementOverrides } from '../../../shared/modules/manifest'
import { getRendererHost, selectModuleEnabled } from '../modules'
import type { SpecialistIcon } from '../specialists/specialistActions'
import type {
  SprintEngineRoleId,
  SprintEngineRoleRegistry,
  SprintEngineRoleRegistryMetadata,
  Workspace,
} from '../types/workspace'
import { getSprintEngineRoleGlyphKind } from '../utils/sprintengine'
import { projectColorGlyphClass, type ProjectColor } from '../utils/projectColor'

type IconProps = {
  className?: string
}

const iconStroke = 1.7

// Resolve a workspace mode to its registered type definition, but only when the
// owning module is enabled. Disabled or unknown modes (and shell-owned
// 'standard') resolve to undefined so callers degrade to the generic/standard
// presentation. The registry is read at render time — never during module init —
// so the components→modules reference here does not create an initialization
// cycle with the workspace-type modules that import these icon components.
export function resolveEnabledWorkspaceType(
  mode: Workspace['mode'],
  moduleOverrides: ModuleEnablementOverrides,
) {
  const definition = getRendererHost().getWorkspaceType(mode)
  if (!definition) return undefined
  return selectModuleEnabled(moduleOverrides, definition.moduleId) ? definition : undefined
}

// Workspace-type identity glyph, resolved through the registry. When
// `moduleOverrides` is supplied the lookup is enablement-gated, so a disabled
// module degrades to the generic standard glyph (the workspace tabs and sidebar
// rows pass it); without it the icon resolves ungated (an unknown/standard id
// still falls back to the generic glyph). This component deliberately takes the
// overrides as a prop rather than reading the workspace store, so this
// universally-imported leaf icon module never pulls the store (and flexlayout-react)
// into utility/test bundles.
//
// A project's own logo never lands here: it belongs to the FOLDER the chats sit
// under, not to each chat (owner, 2026-09-02) — see `FolderTypeIcon` below.
export function WorkspaceTypeIcon({
  mode,
  className,
  moduleOverrides,
}: IconProps & {
  mode: Workspace['mode']
  moduleOverrides?: ModuleEnablementOverrides
}) {
  const definition = moduleOverrides
    ? resolveEnabledWorkspaceType(mode, moduleOverrides)
    : getRendererHost().getWorkspaceType(mode)
  const Icon = definition?.icon ?? StandardWorkspaceTypeIcon
  return <Icon className={className} />
}

// A git branch, for the sidebar row's meta line (remote-sessions-ux /
// two-line-session-rows). 16-grid: it renders at glyph scale inside a row.
// Mirrored framework-neutral as design-system/glyphs/git-branch.svg.
export function GitBranchGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="4.5" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.5" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.7v4.6M11.5 7.2c0 2.4-3.2 2.3-7 2.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

// The stacked-server mark — the epic's ONE machine-provenance glyph
// (remote-sessions-ux decision 7): it marks anything that lives on another
// machine, wherever it appears (session rows, pickers, the Remote popover).
// Local is the unmarked default. 16-grid; mirrored framework-neutral as
// design-system/glyphs/remote-machine.svg.
export function RemoteMachineGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2.8" width="12" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2" y="8.6" width="12" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4.7" cy="5.1" r="0.75" fill="currentColor" />
      <circle cx="4.7" cy="10.9" r="0.75" fill="currentColor" />
    </svg>
  )
}

// The permission-preset vocabulary (remote-sessions-ux / selector-menus-premium),
// a set that reads at a glance and is drawn ONCE: a quiet dial
// for the CLI's own default, a closed lock for Manual, a spark for Auto, an
// open lock for Bypass. The chat composer's permission pill and the shared
// preset menu both draw from here, so "asks before tools" is one lock
// everywhere rather than a 14-grid twin in one file and a 16-grid twin in
// another. 16-grid, `currentColor`, sized by the caller's `icon-*` step.
export function PresetDialGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8l2.4-2.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function LockGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5.4a2.5 2.5 0 0 1 5 0V7" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

// Open-shackle twin of LockGlyph: the agent is NOT stopping to ask.
export function UnlockedGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="3.5" y="7" width="9" height="6" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 7V5.4a2.5 2.5 0 0 0-4.9-.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function SparkGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path
        d="M8 2.5l1.35 3.4 3.4 1.35-3.4 1.35L8 12l-1.35-3.4-3.4-1.35 3.4-1.35L8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M12.6 11.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6.6-1.5Z" fill="currentColor" />
    </svg>
  )
}

// The folder outline a sidebar row or header wears when its project has no logo
// of its own. Drawn on the 16px grid, unlike the 24px workspace-type glyphs
// above it, because the row slot is where it renders. One path, three states.
const FOLDER_GLYPH_PATH =
  'M2 4.5C2 3.67 2.67 3 3.5 3H6.5L8 4.5H12.5C13.33 4.5 14 5.17 14 6V11.5C14 12.33 13.33 13 12.5 13H3.5C2.67 13 2 12.33 2 11.5V4.5Z'

// The folder glyph in its three states, and the ONE place the project colour is
// drawn (owner, 2026-09-09; principles.md → "Identity colour"):
//
//  * `color` — the project's identity hue, as ink on the outline. Nothing else
//    on the row is tinted; the hue names the project, it never grades it.
//  * `unfiled` — a chat with no folder. No folder is not a project, so it gets
//    the dashed outline in --text-disabled and no colour, rather than reading
//    as a seventh project. It outranks `color` because a row with no folder
//    has no project whose colour could apply.
//  * neither — currentColor, exactly the glyph every existing caller had.
//
// The hue is a class, not a style: `project-mark-*` resolves the identity token
// per theme (assets/index.css), so one glyph reads on all eleven. It is an
// UNLAYERED rule and Tailwind's utilities are layered, which is what lets the
// project's hue survive a row that also sets its ink — the row's tint is a
// state, the project's colour is what the row IS.
export function ProjectFolderGlyph({
  className,
  color,
  unfiled,
}: IconProps & { color?: ProjectColor | null; unfiled?: boolean }) {
  const tone = unfiled ? 'text-[color:var(--text-disabled)]' : projectColorGlyphClass(color)
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={`${className ?? ''} ${tone}`.trim()}
    >
      <path
        d={FOLDER_GLYPH_PATH}
        stroke="currentColor"
        strokeWidth="1.4"
        // The dash is the second half of "not a project": on a light theme the
        // disabled ink alone is a faint solid folder, which reads as a project
        // whose colour has not loaded yet rather than as one that has none.
        strokeDasharray={unfiled ? '2 1.6' : undefined}
      />
    </svg>
  )
}

// A folder's identity in an icon slot: `logoSrc` (MC-2135) is the project's own
// logo, detected off the top level of the repo at that folder. When present it
// takes the slot the folder glyph would have had — same className, so the call
// site keeps its geometry — and every path back out of it lands on the plain
// folder glyph: no logo, an empty string, or an image that fails to decode. A
// broken data URI must never leave an empty box behind.
//
// The logo was briefly worn by every workspace row instead (MC-2135 ruling C);
// the owner reversed that on 2026-09-02 — one project, one mark, on the header
// that names the project — and the chat rows lost their icon slot with it.
//
// `color` and `unfiled` pass straight through to ProjectFolderGlyph, so a call
// site that has a project key can hand over the hue without choosing between
// the two components — and a project WITH a logo keeps showing its logo, which
// is why "No colour" exists in the picker at all: a detected logo already
// answers "which project is this", and a hue behind it would be a second answer
// to the same question. Both props are optional and default to the plain glyph,
// so every existing caller is unchanged.
export function FolderTypeIcon({
  className,
  logoSrc,
  color,
  unfiled,
}: IconProps & { logoSrc?: string | null; color?: ProjectColor | null; unfiled?: boolean }) {
  const [brokenLogoSrc, setBrokenLogoSrc] = useState<string | null>(null)

  if (logoSrc && logoSrc !== brokenLogoSrc) {
    return (
      <img
        src={logoSrc}
        alt=""
        aria-hidden="true"
        draggable={false}
        // The image is shown as authored in both themes — no recolor, no
        // invert. The chip radius keeps a square favicon from reading as a
        // sticker, and object-contain keeps a wide wordmark from being
        // squashed into the square slot.
        className={`${className ?? ''} rounded-[var(--radius-xs)] object-contain`}
        onError={() => setBrokenLogoSrc(logoSrc)}
      />
    )
  }

  return <ProjectFolderGlyph className={className} color={color} unfiled={unfiled} />
}

// SprintEngine wherever the app names it as a thing you can open — the Sprints
// door's nav entry, the launcher row, the workspace-type registry. It was a
// three-circle team glyph, which said "a team of agents" while the sidebar mark
// beside it said SprintEngine; one product now has one mark (owner, 2026-08-06).
export function SprintEngineWorkspaceTypeIcon({ className }: IconProps) {
  return <SprintEngineFrond className={className} tone="current" />
}

// The SprintEngine brand mark: the frond the mobile app wears as its
// application icon, so one product's mark is the other's (`brand/
// SprintEngineFrond`, geometry copied from the mobile repo's generator). It
// replaced a comet drawn only here, which meant the two products carried
// different marks for the same name.
//
// Single-color via currentColor — pair it with --tool-sprintengine-ink so it
// stays legible on light and dark themes.
export function SprintEngineMarkIcon({ className }: IconProps) {
  return <SprintEngineFrond className={className} tone="current" />
}

// Automations identity glyph: a schedule dial (the schedule trigger) wrapped
// around a lightning bolt (the fired action) — "on a schedule, do work". Reads
// at 16px in the sidebar.
export function AutomationsWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19.5 12a7.5 7.5 0 1 1-3.4-6.28"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
      />
      <path
        d="M12.6 7.3 9 12.4h2.7l-.7 4 3.6-5.1h-2.7l.7-4z"
        stroke="currentColor"
        strokeWidth={iconStroke - 0.2}
        strokeLinejoin="round"
        fill="currentColor"
        fillOpacity="0.18"
      />
    </svg>
  )
}

function StandardWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5.5" width="16" height="13" rx="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M7.25 10L10 12.5L7.25 15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 15H16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}
export function SpecialistActionIcon({ icon, className }: IconProps & { icon: SpecialistIcon }) {
  switch (icon) {
    case 'architecture':
      return <ArchitectureIcon className={className} />
    case 'code':
      return <CodeIcon className={className} />
    case 'design':
    case 'design_review':
      return <FrontendIcon className={className} />
    case 'review':
      return <ReviewIcon className={className} />
    case 'spaghetti':
      return <SpaghettiIcon className={className} />
    case 'nuclear':
      return <NuclearExplosionIcon className={className} />
    case 'shield':
      return <SecurityIcon className={className} />
    case 'test':
      return <TestIcon className={className} />
    case 'infra':
      return <InfraIcon className={className} />
    case 'product':
      return <ProductIcon className={className} />
    case 'performance':
      return <PerformanceIcon className={className} />
    case 'production_readiness':
      return <ProductionReadinessIcon className={className} />
    case 'cross_platform':
      return <ReviewIcon className={className} />
    case 'writing':
      return <WritingIcon className={className} />
  }
}

export function SprintEngineRoleIcon({
  role,
  registry,
  className,
}: IconProps & {
  // Absent for an agent or task with no role — falls through to the neutral disc.
  role?: SprintEngineRoleId
  // Optional registry metadata so unknown configured roles can opt into a
  // bundled glyph (via the registry `icon` field) without indexing the
  // static role-icon switch directly. When omitted, custom roles fall back
  // to the neutral disc glyph.
  registry?: SprintEngineRoleRegistry | SprintEngineRoleRegistryMetadata | null
}) {
  const glyph = getSprintEngineRoleGlyphKind(role, registry)
  switch (glyph) {
    case 'architect':
      return <ArchitectureIcon className={className} />
    case 'product':
      return <ProductIcon className={className} />
    case 'developer':
      return <CodeIcon className={className} />
    case 'frontend':
    case 'ui_ux_reviewer':
      return <FrontendIcon className={className} />
    case 'tester':
      return <TestIcon className={className} />
    case 'security':
      return <SecurityIcon className={className} />
    case 'performance':
      return <PerformanceIcon className={className} />
    case 'production_readiness_reviewer':
      return <ProductionReadinessIcon className={className} />
    case 'cross_platform':
      return <ReviewIcon className={className} />
    case 'unknown':
    default:
      return <RoleGenericIcon className={className} />
  }
}

// Neutral fallback glyph for registry roles that have no bundled icon.
// A bare disc with a faint inner ring — same chrome budget as the bundled
// role glyphs but with no role-specific iconography, signalling "agent
// identity, role unrecognised" rather than guessing.
function RoleGenericIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth={iconStroke - 0.3} opacity="0.55" />
    </svg>
  )
}

function WritingIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5.25 4.75H14.5L18.75 9V19.25H5.25V4.75Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M14.25 5V9.25H18.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M8 13.25H15.75M8 16.25H13.25" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M7.75 9.5H10.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

// Compose / "new chat" glyph — the pencil-in-square idiom shared by ChatGPT
// and Claude. Used for the sidebar New chat segment and the empty-workspace
// surface. We deliberately do not reuse the plus glyph here: New workspace
// already owns the plus, so a second plus would read as the same action.
export function NewChatIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4H6.5C5.4 4 4.5 4.9 4.5 6V17.5C4.5 18.6 5.4 19.5 6.5 19.5H18C19.1 19.5 20 18.6 20 17.5V12"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M17.6 4a1.6 1.6 0 0 1 2.4 2.4l-7.3 7.3a2 2 0 0 1-.85.5l-2.4.66a.5.5 0 0 1-.62-.62l.66-2.4a2 2 0 0 1 .5-.85z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ArchitectureIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="4.75" width="5.5" height="5.5" rx="1.4" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13.5" y="13.75" width="5.5" height="5.5" rx="1.4" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M10.5 7.5H13.5C15.15 7.5 16.5 8.85 16.5 10.5V13.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M7.75 10.25V13.5C7.75 15.15 9.1 16.5 10.75 16.5H13.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function CodeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.25 8L5.25 12L9.25 16" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14.75 8L18.75 12L14.75 16" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 5.75L11 18.25" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function FrontendIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="11.5" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M8.5 20H15.5M12 16.5V20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M8 9.25H16M8 12.25H12.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function ReviewIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4.75H17V19.25H7V4.75Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M9.5 8.75H14.5M9.5 16H14.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M9.5 12.2L11 13.7L14.5 10.2" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function SpaghettiIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 14.7C7.4 13.1 9.4 13.1 10.75 14.7C12.1 16.3 14.15 16.3 15.55 14.7C16.95 13.1 18.35 13.1 19.35 14.4" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M5.6 11.25C7.35 9.75 9.05 9.75 10.75 11.25C12.45 12.75 14.15 12.75 15.85 11.25C17.3 9.98 18.45 10.08 19.4 11.05" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M7.1 17.2C8.6 18.55 10.3 18.55 11.9 17.2C13.5 15.85 15.25 15.85 16.9 17.2" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="8.2" cy="8.25" r="1.35" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="14.6" cy="7.45" r="1.2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="17.8" cy="8.85" r="0.95" fill="currentColor" />
    </svg>
  )
}

function NuclearExplosionIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4.25V2.95M8.4 5.45L7.55 4.45M15.6 5.45L16.45 4.45M6.8 8.2H5.45M17.2 8.2H18.55" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M7.1 11.25C5.95 10.75 5.35 9.85 5.55 8.85C5.78 7.65 6.95 6.95 8.25 7.25C8.9 5.75 10.25 4.95 12 4.95C13.75 4.95 15.1 5.75 15.75 7.25C17.05 6.95 18.22 7.65 18.45 8.85C18.65 9.85 18.05 10.75 16.9 11.25" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.15 11.55C9.45 12.45 10.05 13.35 10.05 14.65V18.95M15.85 11.55C14.55 12.45 13.95 13.35 13.95 14.65V18.95" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M10.05 14.4H13.95M9.25 18.95H14.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M6.25 20.25C8.2 19.25 15.8 19.25 17.75 20.25M4.25 17.45C6.1 16.6 8.3 16.5 10.05 17.05M19.75 17.45C17.9 16.6 15.7 16.5 13.95 17.05" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function SecurityIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.75L18.75 6.25V11.15C18.75 15.35 16.08 19.08 12 20.25C7.92 19.08 5.25 15.35 5.25 11.15V6.25L12 3.75Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M9 12.05L11.05 14.1L15.25 9.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TestIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 4.75H14.5M10.5 4.75V10.1L6.6 17.05C5.75 18.57 6.85 20.45 8.58 20.45H15.42C17.15 20.45 18.25 18.57 17.4 17.05L13.5 10.1V4.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.15 16.4H15.85" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function InfraIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="4.75" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="5" y="14.25" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M8.25 7.25H8.35M8.25 16.75H8.35M12 9.75V14.25" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M15.5 7.25H16.25M15.5 16.75H16.25" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function ProductIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M14.75 9.25L13.1 13.1L9.25 14.75L10.9 10.9L14.75 9.25Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <circle cx="12" cy="12" r="0.8" fill="currentColor" />
    </svg>
  )
}

function PerformanceIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 15.5C5 11.35 8.15 8 12 8C15.85 8 19 11.35 19 15.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M8.25 15.5H5M19 15.5H15.75M7.35 10.85L9.25 12.75M16.65 10.85L14.75 12.75M12 8V10.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M12 15.25L15.2 12.05" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="15.5" r="1.35" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M7 19.25H17" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

function ProductionReadinessIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M11.25 3.85L17.35 6.1V10.6C17.35 14.1 15.18 17.28 11.25 18.75C7.32 17.28 5.15 14.1 5.15 10.6V6.1L11.25 3.85Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M8.35 11.55L10.3 13.5L14.25 9.55" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.1 17.6L18.75 14.95L21.4 17.6M18.75 15.2V20.15" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15.7 20.15H21.8" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 9.5L12 15L18 9.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5L10 17L19 7.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The finding marker: a real glyph, so it takes currentColor and scales with
// --icon-size-* instead of being drawn as a `▲` character sized below the type
// floor.
export function WarningIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 4.75L20.5 19.25H3.5L12 4.75Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 10V14" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M12 16.75H12.01" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V5A2 2 0 0 1 5 3H13.5A1.5 1.5 0 0 1 15 4.5V5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A document with ruled lines: the release notes behind a version row.
export function ReleaseNotesIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 4.5h8.5L19 9v10.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-14A1 1 0 0 1 6 4.5z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M14.5 4.5V9H19M8.5 13h7M8.5 16.5h7" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// A folder with a plus: install from a folder on disk. Distinct from PlusIcon
// (create) — the thing being added already exists somewhere.
export function FolderPlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M12 10.5v5M9.5 13h5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

// An anticlockwise arrow: return to the default.
export function ResetIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12a8 8 0 1 0 8-8 8.7 8.7 0 0 0-6 2.5L4 8.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 4v4.5h4.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// ── Settings rail glyphs ──────────────────────────────────────────────────
// One line-weight glyph per Settings category, sharing the house stroke so the
// rail reads as a single set. Consumed by SettingsPanel's `settingsTabs`.

export function GeneralSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 8H7.4M11.6 8H20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="9.5" cy="8" r="2.1" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M4 16H13.4M17.6 16H20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="15.5" cy="16" r="2.1" stroke="currentColor" strokeWidth={iconStroke} />
    </svg>
  )
}

export function ProfileSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M5.6 19c0-3.3 2.9-5.4 6.4-5.4s6.4 2.1 6.4 5.4" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function AppearanceSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" />
    </svg>
  )
}

export function ShortcutsSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="6.5" width="18" height="11" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M7 10.5h.01M11 10.5h.01M15 10.5h.01M7.5 14h9" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function AgentsSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="8" width="14" height="11" rx="3" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 5v3" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="12" cy="4" r="1.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M9.5 13h.01M14.5 13h.01" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function ProvidersSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.5 3v3.5M15.5 3v3.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M6.5 6.5h11V10a5.5 5.5 0 0 1-11 0Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M12 15.5V21" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function SpecialistPacksSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.2l7.5 4.3v8.9L12 20.8 4.5 16.4V7.5z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M4.6 7.6L12 11.9l7.4-4.3M12 11.9V20.8" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
    </svg>
  )
}

export function GithubSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4.5v9.6" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="7" cy="17.5" r="2.3" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="17" cy="6.5" r="2.3" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M17 8.8a8.7 8.7 0 0 1-8.6 8.7" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function TrackersSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h9l4.5 4.5v8A1.5 1.5 0 0 1 17.5 19h-12A1.5 1.5 0 0 1 4 17.5z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <circle cx="9" cy="12" r="1.4" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M11.5 12h4" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function KnowledgeGraphSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="7" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="18" cy="7" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="12" cy="17" r="2.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M8.2 7h7.6M7.6 8.7l3.1 6.6M16.4 8.7l-3.1 6.6" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function DesignSystemSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="7.2" cy="7.5" r="2.6" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="14" y="4.9" width="5.2" height="5.2" rx="1.2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M12 13.6l3.6 5.9H8.4z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
    </svg>
  )
}

export function ModulesSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="4" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="13" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
    </svg>
  )
}

export function MobileSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="3" width="10" height="18" rx="2.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M11 17.5h2" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

// Two machines joined by a link: the Remote tab is about this Studio and
// another one, not about a network in the abstract.
export function RemoteSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <rect x="13" y="13" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M7 11v3.5a1.5 1.5 0 0 0 1.5 1.5H13" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}
