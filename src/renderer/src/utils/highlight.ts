import type { HighlightColor, Workspace, WorkspaceHighlight, WorkspaceMode } from '../types/workspace'

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  'red',
  'orange',
  'amber',
  'green',
  'blue',
  'purple',
  'pink',
]

type HighlightSwatch = {
  color: HighlightColor
  label: string
  hex: string
  // Tailwind class fragments for the sidebar row's lit treatment.
  // Mirrors the panel-design-system Tier-2 selection pattern but with
  // the highlight color in place of the module accent.
  border: string // border-l-[color]
  bg: string // bg-[deep-fill]
  text: string // text color for active row label
  shadow: string // composed inset ring + outer halo (expanded sidebar)
  collapsedShadow: string // tighter, dimmer halo for the icon rail
  chip: string // bg tint for the icon backplate when active
  // Shorter helpers used outside the sidebar.
  ringRgba: (alpha: number) => string
}

const swatches: Record<HighlightColor, HighlightSwatch> = {
  red: {
    color: 'red',
    label: 'Red',
    hex: '#ff5a5f',
    border: 'border-l-[#ff5a5f]',
    bg: 'bg-[#1a0a0c]',
    text: 'text-[#ffd5d6]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(255,90,95,0.24),0_0_10px_-6px_rgba(255,90,95,0.20)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(255,90,95,0.22),0_0_6px_-4px_rgba(255,90,95,0.14)]',
    chip: 'bg-[#ff5a5f]/15',
    ringRgba: (a) => `rgba(255, 90, 95, ${a})`,
  },
  orange: {
    color: 'orange',
    label: 'Orange',
    hex: '#ff8c42',
    border: 'border-l-[#ff8c42]',
    bg: 'bg-[#1a0e07]',
    text: 'text-[#ffd9b8]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(255,140,66,0.24),0_0_10px_-6px_rgba(255,140,66,0.18)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(255,140,66,0.22),0_0_6px_-4px_rgba(255,140,66,0.13)]',
    chip: 'bg-[#ff8c42]/15',
    ringRgba: (a) => `rgba(255, 140, 66, ${a})`,
  },
  amber: {
    color: 'amber',
    label: 'Amber',
    hex: '#ffbf2f',
    border: 'border-l-[#ffbf2f]',
    bg: 'bg-[#1a1408]',
    text: 'text-[#ffe7b3]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(255,191,47,0.22),0_0_10px_-6px_rgba(255,191,47,0.18)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(255,191,47,0.22),0_0_6px_-4px_rgba(255,191,47,0.13)]',
    chip: 'bg-[#ffbf2f]/15',
    ringRgba: (a) => `rgba(255, 191, 47, ${a})`,
  },
  green: {
    color: 'green',
    label: 'Green',
    hex: '#30d158',
    border: 'border-l-[#30d158]',
    bg: 'bg-[#0a1a0e]',
    text: 'text-[#bdfbd0]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(48,209,88,0.24),0_0_10px_-6px_rgba(48,209,88,0.18)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(48,209,88,0.22),0_0_6px_-4px_rgba(48,209,88,0.13)]',
    chip: 'bg-[#30d158]/15',
    ringRgba: (a) => `rgba(48, 209, 88, ${a})`,
  },
  blue: {
    color: 'blue',
    label: 'Blue',
    hex: '#5c7cff',
    border: 'border-l-[#5c7cff]',
    bg: 'bg-[#15203c]',
    text: 'text-[#dfe6ff]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(92,124,255,0.26),0_0_10px_-6px_rgba(92,124,255,0.20)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(92,124,255,0.24),0_0_6px_-4px_rgba(92,124,255,0.14)]',
    chip: 'bg-[#5c7cff]/18',
    ringRgba: (a) => `rgba(92, 124, 255, ${a})`,
  },
  purple: {
    color: 'purple',
    label: 'Purple',
    hex: '#a78bfa',
    border: 'border-l-[#a78bfa]',
    bg: 'bg-[#150f2c]',
    text: 'text-[#efe5ff]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(167,139,250,0.28),0_0_10px_-6px_rgba(167,139,250,0.22)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(167,139,250,0.26),0_0_6px_-4px_rgba(167,139,250,0.16)]',
    chip: 'bg-[#a78bfa]/18',
    ringRgba: (a) => `rgba(167, 139, 250, ${a})`,
  },
  pink: {
    color: 'pink',
    label: 'Pink',
    hex: '#ff7eb3',
    border: 'border-l-[#ff7eb3]',
    bg: 'bg-[#1a0c14]',
    text: 'text-[#ffd6e5]',
    shadow:
      'shadow-[inset_0_0_0_1px_rgba(255,126,179,0.26),0_0_10px_-6px_rgba(255,126,179,0.20)]',
    collapsedShadow:
      'shadow-[inset_0_0_0_1px_rgba(255,126,179,0.24),0_0_6px_-4px_rgba(255,126,179,0.14)]',
    chip: 'bg-[#ff7eb3]/15',
    ringRgba: (a) => `rgba(255, 126, 179, ${a})`,
  },
}

export function getHighlightSwatch(color: HighlightColor): HighlightSwatch {
  return swatches[color]
}

export function highlightHex(color: HighlightColor): string {
  return swatches[color].hex
}

export function isStarred(highlight: WorkspaceHighlight | undefined | null): boolean {
  return highlight?.starred === true
}

export function getHighlightColor(
  highlight: WorkspaceHighlight | undefined | null
): HighlightColor | null {
  return highlight?.color ?? null
}

// True when the highlight should override the workspace's mode-accent
// treatment (sidebar row, breadcrumb icon).
export function hasHighlightOverride(
  highlight: WorkspaceHighlight | undefined | null
): boolean {
  return getHighlightColor(highlight) !== null
}

const WORKSPACE_MODE_ACCENT_HEX: Record<WorkspaceMode, string | null> = {
  sprintengine: '#ffbf2f',
  switchboard: '#a78bfa',
  multiloop: '#5c7cff',
  'guided-brief': '#7c5cf2',
  standard: null,
}

// Effective accent for a workspace anywhere outside the sidebar. Highlight
// color wins; otherwise fall back to the workspace mode identity. Standard
// workspaces without a highlight return null so callers can render a neutral
// treatment instead of an arbitrary tint.
export function getWorkspaceAccentHex(
  workspace: Pick<Workspace, 'highlight' | 'mode'>
): string | null {
  if (workspace.highlight?.color) return swatches[workspace.highlight.color].hex
  return WORKSPACE_MODE_ACCENT_HEX[workspace.mode]
}
