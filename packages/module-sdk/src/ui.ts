// `@sprintengine/module-sdk/ui` — the host-provided UI kit.
//
// TYPES ONLY AT RUNTIME. The host supplies the real components through an
// import map when it evaluates a third-party renderer bundle (see the app's
// src/renderer/src/modules/{third-party-loader,sdk-ui}.ts), so this module
// exists to give an author's bundler something to typecheck against and a
// loud failure if the specifier is not marked external. Evaluating it throws.
//
// esbuild:
//   --external:@sprintengine/module-sdk/ui
//
// The shapes below are restated by hand — the SDK cannot import app source —
// and are pinned against the app's components by the drift guard
// (packages/module-sdk/drift/sdk-drift-guard.ts), which asserts both that
// every SDK prop type is accepted by the real component and, where the
// restatement is verbatim, that the two are identical.
//
// A note on styling: these components carry Tailwind utility classes and the
// app's design tokens (CSS custom properties). The tokens come from the host
// stylesheet, but the UTILITIES do not — the app's Tailwind build only scans
// app source, so a class first used inside a module compiles to nothing. A
// module that writes its own Tailwind classes must ship its own
// utilities-only stylesheet.

import type * as React from 'react'

const HOST_PROVIDED_MESSAGE =
  '@sprintengine/module-sdk/ui is provided by the host at runtime; mark it external in your bundler'

function hostProvided(): never {
  throw new Error(HOST_PROVIDED_MESSAGE)
}

// ── Shared vocabulary ────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'error'

/** `Tone` plus the one status-only colour that is not a tone anywhere else. */
export type StatusTone = Tone | 'merged'

export type LifecycleState =
  'todo' | 'idea' | 'ready' | 'blocked' | 'in_progress' | 'paused' | 'needs_input' | 'done' | 'archived' | 'failed'

export type SelectItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
  tone?: Tone
}

export type SegmentedControlItem<V extends string = string> = {
  value: V
  label: string
  disabled?: boolean
  icon?: React.ReactNode
  tooltip?: string
  /**
   * A named count trailing the label — how much is waiting behind this choice
   * (the badge component's count species). `label` joins the segment's
   * accessible name. Ignored on an `iconOnly` strip; null or 0 draws nothing.
   */
  badge?: { count: number; label: string; tone?: Tone } | null
}

export type FilterMenuGroup = {
  label: string
  items: ReadonlyArray<SelectItem<string>>
  value: string
  defaultValue: string
  onChange: (value: string) => void
}

/** The tooltip-wiring props a kit glyph forwards to its host element. */
export type TooltipChildProps = {
  'aria-describedby'?: string
  onMouseEnter?: (event: React.MouseEvent) => void
  onMouseLeave?: (event: React.MouseEvent) => void
  onFocus?: (event: React.FocusEvent) => void
  onBlur?: (event: React.FocusEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}

/** The one focus ring. Compose it onto any custom focusable a module draws. */
export const FOCUS_RING_CLASS: string = hostProvided()

// ── Buttons ──────────────────────────────────────────────────────────────────

type ButtonBase = React.ButtonHTMLAttributes<HTMLButtonElement>

export type ButtonAlign = 'center' | 'start' | 'end'
export type ButtonSize = 'inline' | 'xs' | 'sm' | 'md'
export type ButtonTone = 'neutral' | 'danger'
export type GhostTone = ButtonTone | 'quiet' | 'subtle' | 'strong' | 'accent' | 'ink'

type SizedButtonProps = ButtonBase & {
  size?: ButtonSize
  align?: ButtonAlign
  busy?: boolean
}

export type PrimaryButtonProps = SizedButtonProps
export type GhostButtonProps = SizedButtonProps & {
  tone?: GhostTone
  pressed?: boolean
  armed?: boolean
}
export type OutlineButtonProps = SizedButtonProps & {
  tone?: ButtonTone
  pressed?: boolean
}

type ButtonComponent<P> = React.ForwardRefExoticComponent<
  React.PropsWithoutRef<P> & React.RefAttributes<HTMLButtonElement>
>

/** The one affirmative action on a surface. */
export const PrimaryButton: ButtonComponent<PrimaryButtonProps> = hostProvided()
/** The default button everywhere else. */
export const GhostButton: ButtonComponent<GhostButtonProps> = hostProvided()
/** A bordered button for a secondary action beside a primary one. */
export const OutlineButton: ButtonComponent<OutlineButtonProps> = hostProvided()

export type LinkInk = 'accent' | 'quiet'
export type LinkUnderline = 'hover' | 'always' | 'never'
export type LinkLayout = 'inline' | 'row'

export type LinkButtonProps = ButtonBase & {
  ink?: LinkInk
  underline?: LinkUnderline
  layout?: LinkLayout
  size?: 'meta' | 'inherit'
}

/** A button that reads as a link — navigation, not commitment. */
export const LinkButton: ButtonComponent<LinkButtonProps> = hostProvided()

export type RowButtonDensity = 'row' | 'nav' | 'bleed' | 'flush'
export type RowButtonVariant = 'plain' | 'dashed'

export type RowButtonProps = ButtonBase & {
  density?: RowButtonDensity
  variant?: RowButtonVariant
  selected?: boolean
}

/** A full-width list row that behaves as a button. */
export const RowButton: ButtonComponent<RowButtonProps> = hostProvided()

// ── Inputs ───────────────────────────────────────────────────────────────────

export type InputSize = 'none' | 'xs' | 'sm' | 'content' | 'md'
export type InputVariant = 'default' | 'well' | 'quiet' | 'seamless' | 'composer' | 'inline'

type SharedInputProps = {
  size?: InputSize
  variant?: InputVariant
  fullWidth?: boolean
}

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> & SharedInputProps

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  SharedInputProps & {
    resize?: 'y' | 'none'
  }

export const Input: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<InputProps> & React.RefAttributes<HTMLInputElement>
> = hostProvided()

export const Textarea: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<TextareaProps> & React.RefAttributes<HTMLTextAreaElement>
> = hostProvided()

/** The props a `Field` clones onto its single labelled child. */
export type FieldChildProps = {
  id?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-required'?: boolean
}

export type FieldProps = {
  label: string
  /** Omit for a composite row: the label then renders as a span and nothing
   *  is cloned, and the caller owns the accessible name. */
  htmlFor?: string
  help?: string
  error?: string
  required?: boolean
  children: React.ReactElement<FieldChildProps>
  className?: string
}

export const Field: (props: FieldProps) => React.ReactElement = hostProvided()

export type SelectProps<V extends string = string> = {
  ariaLabel: string
  items: SelectItem<V>[]
  value: V | null
  onChange: (value: V) => void
  disabled?: boolean
  placeholder?: string
  className?: string
  triggerMinWidthClassName?: string
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
  'aria-required'?: boolean
}

export const Select: <V extends string = string>(props: SelectProps<V>) => React.ReactElement = hostProvided()

export type SegmentedControlProps<V extends string = string> = {
  ariaLabel: string
  ariaDescribedBy?: string
  items: SegmentedControlItem<V>[]
  value: V
  onChange: (value: V) => void
  size?: 'sm' | 'md'
  iconOnly?: boolean
  className?: string
}

export const SegmentedControl: <V extends string = string>(props: SegmentedControlProps<V>) => React.ReactElement =
  hostProvided()

// ── Feedback ─────────────────────────────────────────────────────────────────

/** The host's standard panel heading. Tool identity is host-internal. */
export type PanelHeaderProps = {
  title: string
  titleId?: string
  leading?: React.ReactNode
  count?: number | string
  primaryAction?: React.ReactNode
  overflow?: React.ReactNode
  divider?: boolean
  progress?: { value: number; total: number; warnValue?: number; ariaLabel?: string }
} & ({ subtitle?: string; scope?: never } | { subtitle?: never; scope?: React.ReactNode })

export const PanelHeader: (props: PanelHeaderProps) => React.ReactElement = hostProvided()

export type BannerProps = {
  tone: 'error' | 'warn'
  message: string
  onRetry?: () => void
  retryLabel?: string
  /** One extra recovery control beside the retry. */
  action?: React.ReactNode
}

/** Panel-spanning error/warn strip at the top of a content area. */
export const Banner: (props: BannerProps) => React.ReactElement = hostProvided()

export type InlineNoticeTone = 'error' | 'warn'

export type InlineNoticeProps = {
  tone: InlineNoticeTone
  title?: React.ReactNode
  hint?: React.ReactNode
  detail?: string
  children?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Inline-scoped advisory at the failure site. */
export const InlineNotice: (props: InlineNoticeProps) => React.ReactElement = hostProvided()

export type EmptyStateProps = {
  title: React.ReactNode
  body?: React.ReactNode
  glyph?: React.ReactNode
  action?: React.ReactNode
  /** `pane` (default) fills a region; `list` sits inside an empty list. */
  density?: 'pane' | 'list'
  className?: string
}

export const EmptyState: (props: EmptyStateProps) => React.ReactElement = hostProvided()

export type SpinnerProps = {
  size?: number
  /** Supply it and the spinner is announced; omit it and it is decorative. */
  label?: string
  className?: string
}

export const Spinner: (props: SpinnerProps) => React.ReactElement = hostProvided()

export type StatusDotProps = {
  tone: StatusTone
  pulse?: boolean
  label?: string
  size?: number
  className?: string
}

export const StatusDot: (props: StatusDotProps) => React.ReactElement = hostProvided()

export type LifecycleGlyphProps = {
  state: LifecycleState
  label?: string
  live?: boolean
  className?: string
} & Partial<TooltipChildProps>

export const LifecycleGlyph: (props: LifecycleGlyphProps) => React.ReactElement = hostProvided()

// ── Structure ────────────────────────────────────────────────────────────────

export type SectionProps = {
  title?: string
  count?: number | string
  action?: React.ReactNode
  headingId?: string
  level?: 2 | 3 | 4
  /** `true` (default) pads the body, `false` leaves it to the body, `'flush'`
   *  drops the header inset too. */
  inset?: boolean | 'flush'
  className?: string
  children: React.ReactNode
}

export const Section: (props: SectionProps) => React.ReactElement = hostProvided()

export type DrawerProps = {
  open: boolean
  onClose: () => void
  title: string
  ariaLabel: string
  closeLabel?: string
  width?: number
  children: React.ReactNode
}

export type DrawerBodyProps = {
  children: React.ReactNode
  className?: string
}

export const Drawer: ((props: DrawerProps) => React.ReactElement) & {
  Body: (props: DrawerBodyProps) => React.ReactElement
} = hostProvided()

export type TruncatedTextTag = 'p' | 'div' | 'span' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

export type TruncatedTextProps = {
  text: string
  as?: TruncatedTextTag
  className?: string
  placement?: 'top' | 'bottom' | 'left' | 'right'
  id?: string
  multiline?: boolean
}

/** Text that clamps and grows a tooltip only when it actually truncated. */
export const TruncatedText: (props: TruncatedTextProps) => React.ReactElement = hostProvided()

export type KeybindingPlatform = 'darwin' | 'windows' | 'linux'

export type KbdChordProps = {
  keys?: readonly string[]
  chord?: string
  platform?: KeybindingPlatform
  separator?: React.ReactNode
  ariaLabel?: string
  className?: string
}

export const KbdChord: (props: KbdChordProps) => React.ReactElement = hostProvided()

// ── CLI / model picker ───────────────────────────────────────────────────────

/** A CLI runtime's id. Open by design: runtimes are plugin-contributed. */
export type AgentCli = string

export type PluginModelOption = { id: string; label?: string }
export type PluginReasoningOption = { id: string; label?: string }

export type PluginModelCatalog = {
  options: PluginModelOption[]
  allowCustomId: boolean
}

export type PluginReasoningCatalog = {
  levels: PluginReasoningOption[]
  default?: string
}

export type CliRuntimeOption = {
  value: AgentCli
  label: string
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  hostedVia?: 'claude-code'
}

export type CliModelPickerButtonProps = {
  ariaLabel: string
  options: CliRuntimeOption[]
  cli: AgentCli
  effectiveModelFor: (cli: AgentCli) => string | undefined
  effectiveReasoningFor?: (cli: AgentCli) => string | undefined
  onSelectReasoning?: (cli: AgentCli, reasoning: string | null) => void
  disabled?: boolean
  /** Low-emphasis trigger for in-place property editing. */
  quiet?: boolean
  maxWidthClassName?: string
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
}

/** The runtime + model trigger, so a module's agent controls read as the
 *  app's own. Feed it from `RendererHost.listAgentRuntimes()`. */
export const CliModelPickerButton: (props: CliModelPickerButtonProps) => React.ReactElement | null = hostProvided()
