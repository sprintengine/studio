// `@multicode/module-sdk/surface` — the host-provided door shell.
//
// TYPES ONLY AT RUNTIME, exactly like `./ui`: the host resolves this specifier
// through the import map it installs before evaluating a third-party renderer
// bundle. Evaluating this module throws.
//
// esbuild:
//   --external:@multicode/module-sdk/surface
//
// Render a module's modal or global surface inside `GlobalSurfaceShell` and it
// gets the app's own door chrome — title bar, back navigation, rail gutter,
// attention slot — instead of a re-implementation a shade off. `SurfaceRail`
// and `SurfaceCanvasState` are the two substrate pieces every bundled door
// uses for its list column and its loading/empty/error canvas.

import type * as React from 'react'
import type { FilterMenuGroup, SelectItem } from './ui'

const HOST_PROVIDED_MESSAGE =
  '@multicode/module-sdk/surface is provided by the host at runtime; mark it external in your bundler'

function hostProvided(): never {
  throw new Error(HOST_PROVIDED_MESSAGE)
}

// ── The shell ────────────────────────────────────────────────────────────────

export type GlobalSurfaceBar = {
  title: React.ReactNode
  actions?: React.ReactNode
}

export type GlobalSurfaceShellProps = {
  ariaLabel: string
  bar?: GlobalSurfaceBar
  attention?: React.ReactNode
  rail?: React.ReactNode
  onBack?: () => void
  canGoBack?: boolean
  children: React.ReactNode
}

export const GlobalSurfaceShell: (props: GlobalSurfaceShellProps) => React.ReactElement =
  hostProvided()

/** Wire the shell's back affordance to the host's surface history. Pass the
 *  door's own close when it has one. */
export const useSurfaceBackNav: (close?: () => void) => {
  onBack: () => void
  canGoBack: boolean
} = hostProvided()

// ── Canvas states ────────────────────────────────────────────────────────────

export type SurfaceCanvasStateProps =
  | { kind: 'loading'; label: string }
  | {
      kind: 'empty'
      glyph: React.ReactNode
      title: string
      body?: React.ReactNode
      action?: React.ReactNode
      firstRun?: boolean
    }
  | {
      kind: 'error'
      title: string
      hint?: string
      detail?: string
      onRetry: () => void
      retryLabel?: string
      extraAction?: React.ReactNode
    }

export const SurfaceCanvasState: (props: SurfaceCanvasStateProps) => React.ReactElement =
  hostProvided()

// ── The rail ─────────────────────────────────────────────────────────────────

export interface SurfaceRailRow {
  id: string
  title: string
  stateLine: string
  icon?: React.ReactNode
  tooltip?: string
  actions?: React.ReactNode
  onContextMenu?: (position: { x: number; y: number }) => void
  mark?: React.ReactNode
  context?: { icon?: React.ReactNode; label: string; seat?: React.ReactNode }
  detail?: React.ReactNode
  surface?: 'attention' | 'done'
  emphasis?: 'active' | 'quiet'
  overlay?: React.ReactNode
}

export interface SurfaceRailSearch {
  value: string
  onChange: (next: string) => void
  placeholder: string
  ariaLabel: string
}

export interface SurfaceRailFilter {
  ariaLabel: string
  groups: ReadonlyArray<FilterMenuGroup>
}

export interface SurfaceRailScope {
  ariaLabel: string
  items: SelectItem<string>[]
  value: string
  onChange: (value: string) => void
}

export interface SurfaceRailNewAffordance {
  label: string
  selected?: boolean
  onActivate: (anchor: { x: number; y: number }) => void
  disabled?: boolean
}

export interface SurfaceRailGroup {
  key: string
  label: string
  rows: ReadonlyArray<SurfaceRailRow>
}

export type SurfaceRailProps = {
  label: string
  intro?: React.ReactNode
  rows: ReadonlyArray<SurfaceRailRow>
  groups?: ReadonlyArray<SurfaceRailGroup>
  selectedId: string | null
  onSelect: (id: string) => void
  newAffordance: SurfaceRailNewAffordance
  scope?: SurfaceRailScope
  search?: SurfaceRailSearch
  filter?: SurfaceRailFilter
  emptyNotice?: React.ReactNode
  outerContext?: boolean
  afterRows?: React.ReactNode
  afterRowsScope?: 'rows' | 'list'
}

export const SurfaceRail: (props: SurfaceRailProps) => React.ReactElement = hostProvided()
