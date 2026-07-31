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
import type { SwitchboardFolderStatus } from '../../../shared/switchboard'

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

export function SwitchboardWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M9 5.5V18.5M15 5.5V18.5" stroke="currentColor" strokeWidth={iconStroke - 0.3} />
      <rect x="4.75" y="8" width="3" height="2.5" rx="0.6" fill="currentColor" />
      <rect x="10.5" y="11" width="3" height="2.5" rx="0.6" fill="currentColor" />
      <rect x="16.25" y="14" width="3" height="2.5" rx="0.6" fill="currentColor" />
    </svg>
  )
}

export function SprintEngineWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="6" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="6.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="17.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M10.85 8.2L7.65 14.35M13.15 8.2L16.35 14.35M9 16.5H15" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

// The SprintEngine brand mark (assets/brand/sprintengine/sprintengine-mark.svg)
// as an inline component: the comet head with a knocked-out engine port and
// three trailing motion streaks. Single-color via currentColor — pair it with
// --tool-sprintengine-ink so it stays legible on light and dark themes.
export function SprintEngineMarkIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.4 12 L13 5 C17.4 6 20 8.6 20 12 C20 15.4 17.4 18 13 19 Z M16.6 12 C16.6 10.6 15.5 9.5 14.1 9.5 C12.7 9.5 11.6 10.6 11.6 12 C11.6 13.4 12.7 14.5 14.1 14.5 C15.5 14.5 16.6 13.4 16.6 12 Z"
      />
      <path d="M5.4 11.2 L5.4 12.8 L0.8 12 Z" />
      <path d="M6.2 8.3 L6.2 9.7 L2.4 7.1 Z" />
      <path d="M6.2 14.3 L6.2 15.7 L2.4 16.9 Z" />
    </svg>
  )
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

// The Guided Brief identity glyph is the brief/conversation speech-bubble that
// the new-workspace mode card has always shown. Kept here as the single
// registry-owned icon so the mode picker and the top bar render the same mark.
export function GuidedBriefWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 6.25C5 5.42 5.67 4.75 6.5 4.75H17.5C18.33 4.75 19 5.42 19 6.25V13.75C19 14.58 18.33 15.25 17.5 15.25H10.75L7.5 18.5V15.25H6.5C5.67 15.25 5 14.58 5 13.75V6.25Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinejoin="round"
      />
      <path d="M9 9.25H15M9 12H13" stroke="currentColor" strokeWidth={iconStroke - 0.1} strokeLinecap="round" />
    </svg>
  )
}

export function ReviewWorkspaceTypeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5.5 7.5H14" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M5.5 11H11" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M5.5 14.5H9" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <circle cx="15" cy="14.5" r="3.75" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M17.9 17.4L20.5 20" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function StandardWorkspaceTypeIcon({ className }: IconProps) {
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

const PRIORITY_LABELS: Record<'urgent' | 'high' | 'medium' | 'low' | 'none', string> = {
  urgent: 'Urgent priority',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
  none: 'No priority',
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

function priorityKey(priority: number | null | undefined): keyof typeof PRIORITY_LABELS {
  if (priority === 0) return 'urgent'
  if (priority === 1) return 'high'
  if (priority === 2) return 'medium'
  if (priority === 3) return 'low'
  return 'none'
}

export function PriorityIcon({
  priority,
  className,
}: IconProps & { priority: number | null | undefined }) {
  const key = priorityKey(priority)
  const label = PRIORITY_LABELS[key]

  if (key === 'urgent') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="7.5" style={{ fill: 'var(--tone-error)' }} />
        <g style={{ fill: 'var(--text-on-accent)' }}>
          <rect x="11.25" y="7.25" width="1.5" height="6" rx="0.5" fill="currentColor" />
          <circle cx="12" cy="15.75" r="1" fill="currentColor" />
        </g>
      </svg>
    )
  }

  if (key === 'none') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <rect x="6.5" y="11.25" width="3" height="1.5" rx="0.5" fill="currentColor" opacity="0.32" />
        <rect x="10.5" y="11.25" width="3" height="1.5" rx="0.5" fill="currentColor" opacity="0.32" />
        <rect x="14.5" y="11.25" width="3" height="1.5" rx="0.5" fill="currentColor" opacity="0.32" />
      </svg>
    )
  }

  const litCount = key === 'high' ? 3 : key === 'medium' ? 2 : 1
  const useAccentStyle = key === 'high'
  const litStyle = useAccentStyle ? { fill: 'var(--tone-warn)' } : undefined

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      <rect
        x="6.5"
        y="13"
        width="3"
        height="4.5"
        rx="0.6"
        fill="currentColor"
        style={litCount >= 1 ? litStyle : undefined}
        opacity={litCount >= 1 ? 1 : 0.3}
      />
      <rect
        x="10.5"
        y="9"
        width="3"
        height="8.5"
        rx="0.6"
        fill="currentColor"
        style={litCount >= 2 ? litStyle : undefined}
        opacity={litCount >= 2 ? 1 : 0.3}
      />
      <rect
        x="14.5"
        y="5"
        width="3"
        height="12.5"
        rx="0.6"
        fill="currentColor"
        style={litCount >= 3 ? litStyle : undefined}
        opacity={litCount >= 3 ? 1 : 0.3}
      />
    </svg>
  )
}

export function CommentIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 6.5C5 5.95 5.45 5.5 6 5.5H18C18.55 5.5 19 5.95 19 6.5V14.5C19 15.05 18.55 15.5 18 15.5H10.5L7 18.5V15.5H6C5.45 15.5 5 15.05 5 14.5V6.5Z"
        stroke="currentColor"
        strokeWidth={iconStroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const STATUS_LABELS: Record<SwitchboardFolderStatus, string> = {
  inbox: 'Inbox',
  planning: 'Planning',
  todo: 'Todo',
  ready: 'Ready',
  in_progress: 'In progress',
  testing: 'Testing',
  testing_in_progress: 'Testing in progress',
  review: 'Review',
  review_in_progress: 'Review in progress',
  done: 'Done',
  canceled: 'Canceled',
}

export function StatusIcon({
  status,
  className,
}: IconProps & { status: SwitchboardFolderStatus }) {
  const label = STATUS_LABELS[status]

  if (status === 'inbox') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <path
          d="M5 8.5L12 13L19 8.5M5 8L5 16C5 16.55 5.45 17 6 17H18C18.55 17 19 16.55 19 16V8C19 7.45 18.55 7 18 7H6C5.45 7 5 7.45 5 8Z"
          stroke="currentColor"
          strokeWidth={iconStroke}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (status === 'canceled') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth={iconStroke} opacity="0.7" />
        <path d="M8.5 8.5L15.5 15.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" opacity="0.7" />
      </svg>
    )
  }

  if (status === 'done') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" style={{ fill: 'var(--tone-good)' }} />
        <path
          d="M9.25 12L11.25 14L14.75 10.25"
          stroke="currentColor"
          style={{ stroke: 'var(--text-on-accent)' }}
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }

  if (status === 'planning') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle
          cx="12"
          cy="12"
          r="6.4"
          stroke="currentColor"
          strokeWidth={iconStroke}
          strokeDasharray="2 2"
          opacity="0.85"
        />
      </svg>
    )
  }

  if (status === 'todo') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth={iconStroke} />
      </svg>
    )
  }

  if (status === 'ready') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
        <title>{label}</title>
        <circle cx="12" cy="12" r="6.4" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="12" cy="12" r="2" fill="currentColor" />
      </svg>
    )
  }

  // Progress fills for the in_progress / testing / review family.
  // 1/3 fill for in_progress, 2/3 for testing/review. _in_progress variants get a dashed ring.
  const progressFill =
    status === 'in_progress'
      ? 0.33
      : status === 'testing' || status === 'testing_in_progress'
        ? 0.5
        : 0.75
  const dashed = status.endsWith('_in_progress')
  const accentStyle = { fill: 'var(--tool-switchboard)', stroke: 'var(--tool-switchboard)' }

  // Render the fill as a clipped wedge (sweep angle = 360 * progressFill, starting from 12 o'clock).
  const radius = 5.4
  const cx = 12
  const cy = 12
  const sweep = progressFill
  const angle = sweep * 2 * Math.PI
  const endX = cx + radius * Math.sin(angle)
  const endY = cy - radius * Math.cos(angle)
  const largeArc = sweep > 0.5 ? 1 : 0
  const wedgePath = sweep >= 1
    ? null
    : `M ${cx} ${cy} L ${cx} ${cy - radius} A ${radius} ${radius} 0 ${largeArc} 1 ${endX.toFixed(2)} ${endY.toFixed(2)} Z`

  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" role="img" aria-label={label}>
      <title>{label}</title>
      <circle
        cx={cx}
        cy={cy}
        r="6.4"
        stroke="currentColor"
        style={accentStyle}
        strokeWidth={iconStroke}
        strokeDasharray={dashed ? '2 1.6' : undefined}
      />
      {wedgePath ? (
        <path d={wedgePath} fill="currentColor" style={accentStyle} opacity="0.85" />
      ) : (
        <circle cx={cx} cy={cy} r={radius} fill="currentColor" style={accentStyle} opacity="0.85" />
      )}
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

export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5.5V18.5M5.5 12H18.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function MinusIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5.5 12H18.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
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

export function CloseIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6.5 6.5L17.5 17.5M17.5 6.5L6.5 17.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
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

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12H18.5M13 6.5L18.5 12L13 17.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
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

export function RolesSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth={iconStroke} />
      <circle cx="9" cy="11" r="2" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M6 16c0-1.7 1.3-2.6 3-2.6s3 .9 3 2.6" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M14.5 10h3.5M14.5 13.5h3.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
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

export function VoiceDictationSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9.5" y="3" width="5" height="10" rx="2.5" stroke="currentColor" strokeWidth={iconStroke} />
      <path d="M6.5 11a5.5 5.5 0 0 0 11 0" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      <path d="M12 16.5V20M9 20h6" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
    </svg>
  )
}

export function LearnSettingsIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 6.5C10.5 5 7.5 4.5 5 5v13c2.5-.5 5.5 0 7 1.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
      <path d="M12 6.5C13.5 5 16.5 4.5 19 5v13c-2.5-.5-5.5 0-7 1.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
    </svg>
  )
}
