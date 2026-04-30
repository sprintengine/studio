import type { SpecialistIcon } from '../specialists/specialistActions'
import type { SwarmRole, Workspace } from '../types/workspace'

type IconProps = {
  className?: string
}

type StatusDotTone = 'idle' | 'running' | 'needs-input' | 'done' | 'error'

const iconStroke = 1.7

export function StatusDot({
  tone,
  label,
  className = '',
}: {
  tone: StatusDotTone
  label: string
  className?: string
}) {
  const toneClass = {
    idle: 'bg-[#5a5a63]',
    running: 'bg-[#30d158]',
    'needs-input': 'animate-pulse bg-[#ffbf2f] shadow-[0_0_8px_rgba(255,191,47,0.75)]',
    done: 'bg-[#30d158]',
    error: 'bg-[#ff787c]',
  }[tone]

  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${toneClass} ${className}`}
      title={label}
      aria-label={label}
    />
  )
}

export function WorkspaceTypeIcon({
  mode,
  className,
}: IconProps & {
  mode: Workspace['mode']
}) {
  if (mode === 'swarm') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="6" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="6.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <circle cx="17.5" cy="16.5" r="2.4" stroke="currentColor" strokeWidth={iconStroke} />
        <path d="M10.85 8.2L7.65 14.35M13.15 8.2L16.35 14.35M9 16.5H15" stroke="currentColor" strokeWidth={iconStroke} strokeLinecap="round" />
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
  }
}

export function SwarmRoleIcon({ role, className }: IconProps & { role: SwarmRole }) {
  switch (role) {
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
    case 'performance':
      return <PerformanceIcon className={className} />
  }
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
