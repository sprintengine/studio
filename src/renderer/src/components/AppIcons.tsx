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

export function WorkspaceTypeIcon({
  mode,
  className,
}: IconProps & {
  mode: Workspace['mode']
}) {
  if (mode === 'switchboard') {
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

  if (mode === 'sprintengine') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="6" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="6.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="17.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <path d="M10.85 8.2L7.65 14.35M13.15 8.2L16.35 14.35M9 16.5H15" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      </svg>
    )
  }

  if (mode === 'multiloop') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="7.5" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth={iconStroke} strokeOpacity="0.5" />
        <path d="M12 4.5 A7.5 7.5 0 0 1 19.5 12" stroke="currentColor" strokeWidth={iconStroke + 0.5} strokeLinecap="round" />
      </svg>
    )
  }

  if (mode === 'guided-brief') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M5 5.5H15.25L19 9.25V18.5H5V5.5Z" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
        <path d="M15 5.75V9.5H18.75" stroke="currentColor" strokeWidth={iconStroke} strokeLinejoin="round" />
        <path d="M8 12.25H15.5M8 15.25H13" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
      </svg>
    )
  }

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
      return <FrontendIcon className={className} />
    case 'review':
      return <ReviewIcon className={className} />
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
    case 'writing':
      return <WritingIcon className={className} />
  }
}

export function SprintEngineRoleIcon({
  role,
  registry,
  className,
}: IconProps & {
  role: SprintEngineRoleId
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
      return <FrontendIcon className={className} />
    case 'tester':
      return <TestIcon className={className} />
    case 'security':
      return <SecurityIcon className={className} />
    case 'code_reviewer':
      return <ReviewIcon className={className} />
    case 'spec_reviewer':
      return <ReviewIcon className={className} />
    case 'performance':
      return <PerformanceIcon className={className} />
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

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12H18.5M13 6.5L18.5 12L13 17.5" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
