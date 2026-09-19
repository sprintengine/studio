import React from 'react'

import type { TailnetScope } from '../../../../shared/tailnet'
import type { TailnetMachine } from '../../../../shared/tailnet-machines'
import { relativeSeen } from '../../../../shared/tailnet-machines'
import { GhostButton, LinkButton, MicroChip, OutlineButton, Popover, SettingCard, deviceGlyphFor } from '../ui'
import { missingScopes, terminalGapNote } from './scopePickerModel'
import { platformLabel } from './machineRowModel'

// One machine in Settings → Remote (remote-settings-rebuild), whichever
// directions it is known from.
//
// The row says four things and no more: which machine, what kind, what it may
// do here, and whether it is awake. Everything the old three lists carried —
// the tailnet address, the port, where the pairing came from, whether whois
// resolved — is gone, because none of it was ever a fact anyone acted on. What
// IS acted on is the scope set, and that used to be a bare count with no way to
// see or change it; it is now the one link on the row.
//
// Dimming is the whole vocabulary for "asleep". The word "offline" never
// appears: a machine that is off is not in an error state, and a red dot beside
// four of five rows on a personal tailnet trains a person to ignore dots.

/**
 * The machines list surface: one bordered card, rows divided by hairlines.
 *
 * Now the kit's `SettingCard` in its list form — this file drew the same
 * surface by hand until 2026-09-14, which made it the third copy of one card
 * after `DescribedCheckRowList`.
 */
export function MachineList({ ariaLabel, children }: { ariaLabel?: string; children: React.ReactNode }) {
  return (
    <SettingCard as="ul" ariaLabel={ariaLabel}>
      {children}
    </SettingCard>
  )
}

export function MachineRow({
  machine,
  now,
  onPair,
  onRevoke,
  onGrant,
  busy = false,
}: {
  machine: TailnetMachine
  now: number
  /** Opens the pairing modal against this machine's Studio endpoint. */
  onPair: (machine: TailnetMachine) => void
  onRevoke: (machine: TailnetMachine) => void
  /** Widen the inbound grant to the full Standard set. */
  onGrant: (machine: TailnetMachine) => void
  busy?: boolean
}) {
  const [scopesOpen, setScopesOpen] = React.useState(false)
  const Glyph = deviceGlyphFor({ os: machine.os, hostName: machine.name })
  const paired = machine.inbound !== null || machine.outbound !== null
  // "Asleep" for the dimming rule is about a REMOTE machine: this one is never
  // dimmed, whatever Tailscale thinks of its own node.
  const dim = !machine.isSelf && !machine.live && !machine.online
  const seen = relativeSeen(machine.lastSeenAt, now)

  const supporting: React.ReactNode[] = []
  const platform = platformLabel(machine.os)
  if (platform) supporting.push(<span key="platform">{platform}</span>)
  if (paired) {
    supporting.push(
      <ScopesPopover
        key="scopes"
        machine={machine}
        open={scopesOpen}
        onOpenChange={setScopesOpen}
        onGrant={() => onGrant(machine)}
        busy={busy}
      />,
    )
  }
  if (machine.live) {
    supporting.push(
      <span key="live" className="font-medium text-[color:var(--tone-good)]">
        Live
      </span>,
    )
  } else if (!machine.isSelf && seen.short) {
    // The token is tiny on purpose — it must not compete with the name — and
    // the whole phrase rides the `title`, which is also what a screen reader
    // gets: "3d" is not a thing anyone can read out loud.
    supporting.push(
      <span key="seen" className="font-mono tabular-nums" title={seen.long}>
        {seen.short}
      </span>,
    )
  }

  return (
    <li className="flex items-center gap-3 px-4 py-3" data-machine={machine.key}>
      <span
        aria-hidden="true"
        className={[
          'flex shrink-0 self-start pt-0.5',
          dim ? 'text-[color:var(--text-disabled)]' : 'text-[color:var(--text-strong)]',
        ].join(' ')}
      >
        <Glyph className="size-icon-md" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div
          className={[
            'flex min-w-0 items-center gap-2 text-body',
            dim ? 'text-[color:var(--text-muted)]' : 'font-medium text-[color:var(--text-strong)]',
          ].join(' ')}
        >
          <span className="truncate">{machine.name}</span>
          {machine.isSelf ? <MicroChip>This device</MicroChip> : null}
        </div>
        {supporting.length > 0 ? (
          <div
            className={[
              'flex flex-wrap items-baseline gap-x-1.5 text-meta',
              dim ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-muted)]',
            ].join(' ')}
          >
            {supporting.map((node, index) => (
              <React.Fragment key={index}>
                {index > 0 ? (
                  <span aria-hidden="true" className="text-[color:var(--text-subtle)]">
                    ·
                  </span>
                ) : null}
                {node}
              </React.Fragment>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {machine.isSelf ? null : paired ? (
          <GhostButton size="xs" tone="danger" disabled={busy} onClick={() => onRevoke(machine)}>
            Revoke
          </GhostButton>
        ) : (
          // Dead rather than absent for a machine that is asleep or runs no
          // Studio: the row is still the answer to "can I pair with that?", and
          // a button that vanished would read as the scan having missed it.
          <OutlineButton
            size="xs"
            disabled={busy || !machine.online || !machine.studio}
            onClick={() => onPair(machine)}
          >
            Pair
          </OutlineButton>
        )}
      </div>
    </li>
  )
}

/**
 * "6 scopes", and what those six are.
 *
 * The set shown is the INBOUND grant — what that machine may do HERE — because
 * that is the half this keyboard controls, and therefore the only half a Grant
 * can widen. An outbound credential with a different set gets its own read-only
 * group rather than being averaged into one count, since "what it may do here"
 * and "what I may do there" are two questions with two answers.
 */
function ScopesPopover({
  machine,
  open,
  onOpenChange,
  onGrant,
  busy,
}: {
  machine: TailnetMachine
  open: boolean
  onOpenChange: (open: boolean) => void
  onGrant: () => void
  busy: boolean
}) {
  const granted = machine.inbound?.scopes ?? []
  const missing = missingScopes(granted)
  const note = terminalGapNote(granted)
  const outbound = machine.outbound?.scopes ?? null
  const differs = outbound !== null && !sameScopes(outbound, granted)
  const shown = machine.inbound ? granted : (outbound ?? [])

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={`Scopes granted to ${machine.name}`}
      popupRole="dialog"
      placement="bottom-start"
      className="align-baseline"
      renderTrigger={({ ref, togglePopover, triggerProps }) => (
        <LinkButton ref={ref} {...triggerProps} ink="quiet" onClick={togglePopover}>
          {shown.length === 1 ? '1 scope' : `${shown.length} scopes`}
        </LinkButton>
      )}
    >
      {/* design-system/components/popover → the `scope body` parts. The kit
          spells design-system parts as utilities rather than as `ds-` classes,
          the way every other primitive in ui/ does. */}
      <div className="flex min-w-[236px] max-w-[300px] flex-col gap-2 px-3 py-2">
        {machine.inbound ? (
          <>
            <div className="text-meta font-semibold text-[color:var(--text-strong)]">Granted scopes</div>
            <ScopeLines scopes={granted} />
            {missing.length > 0 ? (
              <>
                <div className="h-px bg-[color:var(--border-subtle)]" />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-meta font-semibold text-[color:var(--text-muted)]">Not granted</span>
                  <LinkButton onClick={onGrant} disabled={busy}>
                    Grant
                  </LinkButton>
                </div>
                <ScopeLines scopes={missing} missing />
              </>
            ) : null}
            {note ? <div className="text-micro text-[color:var(--text-muted)]">{note}</div> : null}
          </>
        ) : null}
        {differs || !machine.inbound ? (
          <>
            {machine.inbound ? <div className="h-px bg-[color:var(--border-subtle)]" /> : null}
            <div className="text-meta font-semibold text-[color:var(--text-strong)]">What you can do there</div>
            <ScopeLines scopes={outbound ?? []} />
          </>
        ) : null}
      </div>
    </Popover>
  )
}

function ScopeLines({ scopes, missing = false }: { scopes: readonly TailnetScope[]; missing?: boolean }) {
  return (
    <ul
      className={[
        'm-0 flex list-none flex-col gap-0.5 p-0 font-mono text-meta',
        missing ? 'text-[color:var(--text-subtle)]' : 'text-[color:var(--text-default)]',
      ].join(' ')}
    >
      {scopes.map((scope) => (
        <li key={scope}>{scope}</li>
      ))}
    </ul>
  )
}

function sameScopes(left: readonly TailnetScope[], right: readonly TailnetScope[]): boolean {
  if (left.length !== right.length) return false
  const held = new Set(right)
  return left.every((scope) => held.has(scope))
}
