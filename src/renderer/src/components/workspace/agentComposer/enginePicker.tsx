import React, { type JSX } from 'react'

import CliIcon from '../../CliIcon'
import { ChipButton, CliModelPopoverSurface, Popover, Tooltip, TruncatedText } from '../../ui'
import type { CliRuntimeOption } from '../../ui/CliModelPicker'
import type { AgentCli } from '../../../types/workspace'
import { ChipCaretGlyph } from './agentSpawnShared'
import { engineNames } from './useAgentComposer'

// The engine chip: the CLI's own mark and the model's name, opening the model
// picker (a CLI rail, the CLI's named models, the effort control and the
// permission control on its trailing row). ONE component, because the New agent
// launcher and a running chat agent's composer must offer the same picker, not
// two that resemble each other.
//
// The launcher hands it every installed CLI (or, for a chat agent, the ones
// with a chat runtime) and writes picks to the remembered engine; a chat hands
// it its own CLI alone and writes picks to that chat.

export type EnginePickerChipProps = {
  /** The CLI the chip stands on. */
  cli: AgentCli
  /** The rail: every CLI this host lets the person choose. */
  options: ReadonlyArray<CliRuntimeOption>
  /** The model picked on `cli`; undefined is the CLI's own default. */
  model: string | undefined
  /** The effort picked on `cli`; undefined is the CLI's own default. */
  reasoning: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectCli: (cli: AgentCli) => void
  onSelectModel: (cli: AgentCli, model: string | null) => void
  onSelectReasoning: (cli: AgentCli, reasoning: string | null) => void
  /** The permission control for the highlighted row's CLI, on the trailing row beside effort. */
  permissions: (cli: AgentCli, model: string | null) => React.ReactNode
  /** A quiet line over one CLI's models — a chat uses it to say its model is fixed once it has started. */
  groupNote?: { cli: AgentCli; note: string }
  /** Which side the picker opens on; it flips when there is no room. */
  placement?: 'bottom-start' | 'top-start'
  /** The rendered shortcut that toggles the picker, for the chip's tip; absent when unbound. */
  shortcutLabel?: string | null
  /**
   * A standing warning about what the picker holds — a running chat's
   * permissions at Bypass, or at a preset it cannot run — in words. The chip
   * wears the warn tint and says the words in its tip and its name, because
   * the permissions it would otherwise show on a chip of their own are inside
   * the picker now, and a safeguard that is off must not go quiet with them.
   */
  warn?: string | null
  /**
   * Whether the launch can honour an effort level. Off for a chat on a paired
   * machine that keeps none: the picker leaves the effort control out and the
   * chip names no level, rather than offer one that would go nowhere.
   */
  effortOffered?: boolean
}

export function EnginePickerChip({
  cli,
  options,
  model,
  reasoning,
  open,
  onOpenChange,
  onSelectCli,
  onSelectModel,
  onSelectReasoning,
  permissions,
  groupNote,
  placement = 'bottom-start',
  shortcutLabel,
  warn,
  effortOffered = true,
}: EnginePickerChipProps): JSX.Element {
  const names = engineNames(options, cli, model)
  const label = names.modelLabel ?? names.cliLabel
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={`Engine: ${names.cliLabel}`}
      popupRole="menu"
      placement={placement}
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        // The kit's raised chip: a control in the composer's toolbar row,
        // standing off it on the same edge as every other control there. A
        // solid-ish accent on a standing chip would spend the accent budget on
        // a state display rather than on the view's one primary action
        // (principles.md → The accent budget).
        const chip = (
          <ChipButton
            ref={ref}
            variant="raised"
            tone="neutral"
            // The permission chip's own warn tint, carried here with the
            // control it moved into: an ink and its soft ground, not a fill.
            {...(warn ? { tint: 'var(--tone-warn)' } : {})}
            onClick={togglePopover}
            // Named, not left to its contents: the chip is a mark plus a
            // truncated label, and it is the only way to the model, effort and
            // permissions the picker holds.
            aria-label={warn ? `Engine: ${label} — ${warn}` : `Engine: ${label}`}
            data-engine-warn={warn ? 'true' : undefined}
            {...triggerProps}
          >
            {/* The CLI's own mark is the identity — the word "claude" beside a
                Claude asterisk was saying it twice. */}
            <CliIcon cli={cli} className="icon-xs" />
            <TruncatedText as="span" text={label} className="max-w-[150px]" />
            {reasoning && effortOffered ? <span className="text-[color:var(--text-subtle)]">· {reasoning}</span> : null}
            <ChipCaretGlyph />
          </ChipButton>
        )
        const tip = shortcutLabel ? `Model and permissions (${shortcutLabel})` : null
        const content = warn ? (tip ? `${warn} · ${tip}` : warn) : tip
        return content ? (
          <Tooltip content={content} placement="top">
            {chip}
          </Tooltip>
        ) : (
          chip
        )
      }}
    >
      {/* Reasoning effort is a property OF the model, so it lives in the model's
          own picker rather than as a second control beside the chip, and the
          permission preset sits on the same trailing row (owner, 2026-09-05). */}
      <CliModelPopoverSurface
        ariaLabel="Agent runtime"
        options={options}
        currentCli={cli}
        effectiveModelFor={(target) => (target === cli ? model : undefined)}
        effectiveReasoningFor={(target) => (target === cli ? reasoning : undefined)}
        onSelectReasoning={onSelectReasoning}
        showReasoning
        showReasoningLevels={effortOffered}
        reasoningAriaLabel="Reasoning effort"
        onSelectCli={onSelectCli}
        onSelectModel={onSelectModel}
        permissions={permissions}
        {...(groupNote ? { groupNote } : {})}
      />
    </Popover>
  )
}
