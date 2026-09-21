// The composer's model and permission-preset pickers.

import type { ConversationProviderModel } from '../../../../../shared/plugin-manifest'
import type { CliPermissionPreset } from '../../../types/workspace'
import {
  Popover,
  MENU_LIST_CLASS,
  Tooltip,
  ChipButton,
  MENU_DIVIDER_CLASS,
  TruncatedText,
  FOCUS_RING_WITHIN_INPUT_CLASS,
  Input,
  FilterMenu,
  MENU_GROUP_LABEL_CLASS,
  GhostButton,
  MenuOption,
} from '../../ui'
import {
  focusActivePresetRow,
  agentPermissionOptions,
  PermissionPresetMenuRows,
} from '../../workspace/agentComposer/agentSpawnShared'
import { LockGlyph, UnlockedGlyph, CheckIcon } from '../../AppIcons'
import { useState, useEffect, useCallback } from 'react'

// The in-composer model selector. Before the conversation starts it is a pill
// that opens a grouped provider → model menu; once locked it renders as static
// muted text (the session is bound to its model).
export type ModelGroup = {
  providerId: string
  providerLabel: string
  // True for agent-harness providers — the user's own subscription, annotated
  // in the menu so metered API providers are visibly different.
  subscription?: boolean
  // Plain-language reason the provider cannot start sessions; renders the
  // group disabled instead of hiding it.
  unavailable?: string
  models: ConversationProviderModel[]
  // Explicit empty state for a dynamic-catalog provider with no models to list,
  // so it is never dropped nor shown as a silent stale seed. 'add-key' — no key
  // configured; 'no-models' — key present but the live catalog came back empty.
  emptyState?: 'add-key' | 'no-models'
}

// What the picker actually lists, given the search box and the provider chip.
// Search matches the provider as well as the model: "claude" must keep the
// Claude Code (subscription) group visible even though its models are named
// Sonnet/Opus/Haiku — otherwise the search silently hides the subscription and
// leaves only metered lookalikes. Browsing (no query) keeps every provider group
// so a key-configured provider never disappears for an empty catalog — its empty
// state renders inline (1772/D5) — and respects the active chip; a query looks
// across every provider, because a filter must never hide a search hit.
export function filterModelGroups(groups: ModelGroup[], query: string, activeFilter: string): ModelGroup[] {
  const normalized = query.trim().toLowerCase()
  const providerMatches = (group: ModelGroup): boolean =>
    group.providerLabel.toLowerCase().includes(normalized) || group.providerId.toLowerCase().includes(normalized)
  if (!normalized) {
    return groups.filter((group) => activeFilter === 'all' || group.providerId === activeFilter)
  }
  return groups
    .map((group) =>
      providerMatches(group)
        ? group
        : {
            ...group,
            models: group.models.filter(
              (model) =>
                model.id.toLowerCase().includes(normalized) ||
                (model.displayName?.toLowerCase().includes(normalized) ?? false),
            ),
          },
    )
    .filter((group) => providerMatches(group) || group.models.length > 0)
}

// Plain-language name for a tool-permission preset, as the composer pill reads
// it. The spawn picker's own labels ("Default permissions") name the setting;
// the pill has to name the BEHAVIOR, because at rest it is the answer to "will
// this agent stop and ask me before it acts?".
export function permissionPresetLabel(preset: CliPermissionPreset, cli?: string): string {
  // `none` cannot claim "asks before tools": it sends no flag, so the answer is
  // whatever the CLI does — auto mode on Claude Code 2.1.228+ with a Pro, Max or
  // Team plan. Naming the behaviour is the whole job of this pill, and the one
  // behaviour it must not assert here is the one it cannot know.
  if (preset === 'none') return 'CLI default'
  if (preset === 'auto') return 'Auto'
  if (preset === 'bypass') return agentPermissionOptions(cli).find((option) => option.value === preset)!.label
  return 'Asks before tools'
}

// When a preset change actually bites. A live session takes it on the running
// query's next tool call; with no session yet it is simply what the session
// will start with. Stated plainly so the user is never left guessing whether
// the switch they just made covers the work already in flight.
export function permissionChangeScopeLabel(live: boolean): string {
  return live ? 'Applies from the next tool call.' : 'Applies when the conversation starts.'
}

// The composer footer's tool-permission control. Replaces the read-only "Asks
// before tools" chip: the preset was start-time-only, so a conversation was
// stuck with whatever it spawned on. The pill names the current behavior at
// rest and opens the SHARED Default/Auto/Bypass row (the same control the spawn
// picker and Automations editor use) rather than three always-on chips, so the
// footer keeps one control per concern.
export function PermissionPresetPill({
  cli,
  preset,
  live,
  changing,
  open,
  onOpenChange,
  onChange,
}: {
  cli?: string
  preset: CliPermissionPreset
  // Whether a session is running: only then is this a live mutation.
  live: boolean
  // A change is in flight. The pick closes the popover, but the user can reopen
  // it before the push lands — the row locks so that second click reads as
  // "wait", instead of being silently dropped by the caller's re-entry guard.
  changing: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (preset: CliPermissionPreset) => void
}) {
  const asks = preset === 'manual'
  // The surface portals to <body>, so Tab from the trigger would never reach the
  // rows. Land focus on the preset in force (Escape returns it to the trigger)
  // — the one helper the launch panel's pill uses too.
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Tool permissions"
      popupRole="menu"
      placement="top-start"
      // The list rides the surface itself, so the popover's `role="menu"` is
      // the only one: a second menu role nested inside it announced two menus.
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusActivePresetRow}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip
          content={
            agentPermissionOptions(cli).find((option) => option.value === preset)?.title ??
            permissionPresetLabel(preset, cli)
          }
          placement="top"
        >
          {/* `ChipButton`, not a ghost: the bypass warning is an INK the chip
              names as a tone, and a ghost tone map has no warn — spelling it in
              `className` would put two `text-[color:var(--…)]` utilities of equal
              specificity on the element. Content height, so it rides the footer
              strip rather than setting it. */}
          <ChipButton
            ref={ref}
            tone={preset === 'bypass' ? 'warn' : 'subtle'}
            onClick={togglePopover}
            className="shrink-0"
            {...triggerProps}
          >
            {asks ? <LockGlyph className="icon-xs" /> : <UnlockedGlyph className="icon-xs" />}
            {permissionPresetLabel(preset, cli)}
            <ChevronGlyph className="icon-xs text-[color:var(--text-disabled)]" />
          </ChipButton>
        </Tooltip>
      )}
    >
      {/* The menu spec's stacked items, shared with the launch panel's pill
          (remote-sessions-ux / selector-menus-premium): glyph + name +
          description per row, full-bleed on the list's own vertical inset. */}
      <PermissionPresetMenuRows cli={cli} value={preset} onSelect={onChange} disabled={changing} />
      <div className={MENU_DIVIDER_CLASS} role="separator" />
      <p className="px-2.5 pb-0.5 pt-0.5 text-micro leading-4 text-[color:var(--text-subtle)]">
        {permissionChangeScopeLabel(live)}
      </p>
    </Popover>
  )
}

export function ModelPickerPill({
  label,
  shortcutLabel,
  locked,
  open,
  onOpenChange,
  groups,
  selectedProviderId,
  selectedModelId,
  onSelect,
  onBrowseProvider,
  onAddKey,
}: {
  label: string
  /** The rendered toggle chord (⌘⇧M), for the trigger's tip; null when unbound. */
  shortcutLabel?: string | null
  locked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ModelGroup[]
  selectedProviderId: string
  selectedModelId: string
  onSelect: (providerId: string, modelId: string) => void
  // Fired when the user opens the picker or filters to a specific provider, so
  // the parent fetches THAT provider's live catalog (never a blanket prefetch).
  // 'all' is not a provider and is not fetched.
  onBrowseProvider: (providerId: string) => void
  // Opens provider settings to configure a missing key for the given provider.
  onAddKey: (providerId: string) => void
}) {
  const [query, setQuery] = useState('')
  // Provider filter chips: pick one provider to browse, or All.
  // `null` means "not chosen yet" — resolved to the subscription provider when
  // one exists, so opening the picker never starts in a metered catalog.
  const [providerFilter, setProviderFilter] = useState<string | null>(null)
  if (locked) {
    return (
      <Tooltip content="Model is fixed once the conversation starts" placement="top">
        <span className="inline-flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-meta text-[color:var(--text-muted)]">
          <ChatGlyph className="icon-sm text-[color:var(--text-subtle)]" />
          <span className="max-w-[200px] truncate">{label}</span>
        </span>
      </Tooltip>
    )
  }
  // Default to the subscription provider only when it can actually be picked —
  // an unavailable harness must not leave the at-rest view all-disabled while
  // selectable providers hide behind the filter.
  const defaultFilter = groups.find((group) => group.subscription && !group.unavailable)?.providerId ?? 'all'
  const activeFilter = providerFilter ?? defaultFilter
  const normalized = query.trim().toLowerCase()
  const filtered = filterModelGroups(groups, query, activeFilter)
  const totalModels = groups.reduce((sum, group) => sum + group.models.length, 0)
  // The rows in reading order, for the ⌘1–9 model-jump chords:
  // the Nth choosable row as the eye sees it, filtered list included, so the
  // hint on a row and the key that picks it can never disagree.
  const jumpRows = filtered.flatMap((group) =>
    group.unavailable ? [] : group.models.map((model) => ({ providerId: group.providerId, modelId: model.id })),
  )
  const jumpRowsKey = jumpRows.map((row) => `${row.providerId}:${row.modelId}`).join('\n')
  const jumpModifier = window.api.platform === 'darwin' ? '⌘' : 'Ctrl+'
  useEffect(() => {
    if (!open) return
    // Capture on window, like the shell's dispatcher, so the digit never
    // reaches the search field as text. The workspace-switch chords on the
    // same keys are suppressed by the shell while focus is in the search
    // field (editable) or on a row (the list is `data-suppress-shortcuts`).
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.altKey || event.shiftKey) return
      const primary = window.api.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (!primary || !/^[1-9]$/.test(event.key)) return
      const target = jumpRows[Number(event.key) - 1]
      if (!target) return
      event.preventDefault()
      event.stopPropagation()
      onSelect(target.providerId, target.modelId)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // jumpRows is derived per render; re-subscribe only when the rows change.
  }, [open, onSelect, jumpRowsKey])
  // Focus lands in the search field when there is one, else on the checked
  // row — the surface is portaled, so Tab from the trigger never reaches it.
  const focusOnOpen = useCallback((surface: HTMLElement) => {
    const target =
      surface.querySelector<HTMLElement>('input') ??
      surface.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
      surface.querySelector<HTMLElement>('[role="menuitemradio"]:not([disabled])')
    if (!target) return
    target.focus()
    if (document.activeElement === target) return
    requestAnimationFrame(() => {
      if (surface.isConnected) target.focus()
    })
  }, [])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setQuery('')
          // Load the catalog for the provider the picker opens onto.
          if (activeFilter !== 'all') onBrowseProvider(activeFilter)
        }
        onOpenChange(next)
      }}
      ariaLabel="Select model"
      popupRole="menu"
      placement="top-start"
      onOpenAutoFocus={focusOnOpen}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <Tooltip content={shortcutLabel ? `Model · ${shortcutLabel}` : 'Model'} placement="top">
          <ChipButton
            ref={ref}
            tone="neutral"
            onClick={togglePopover}
            aria-keyshortcuts={shortcutLabel ?? undefined}
            {...triggerProps}
          >
            <ChatGlyph className="icon-sm text-[color:var(--text-muted)]" />
            <TruncatedText as="span" text={label} className="max-w-[200px]" />
            <ChevronGlyph className="icon-xs text-[color:var(--text-disabled)]" />
          </ChipButton>
        </Tooltip>
      )}
    >
      <div className="flex max-h-[400px] w-[300px] flex-col overflow-hidden">
        {totalModels > 8 || groups.length > 1 ? (
          // Search + the shared filter glyph, matching the panel-toolbar
          // pattern (Backlog, agent composer): search is the at-rest control,
          // the provider axis collapses behind FilterMenu.
          // The glyph + field + menu row is the composed control the kit's
          // `seamless` field is made for: the BOX is this wrapper, which draws
          // the edge and takes the ring for whatever input is focused inside it.
          // A `seamless` field without that wrapper class has no focus indicator
          // at all, which is why the two arrive together.
          <div
            className={`flex items-center gap-1 border-b border-[color:var(--border-subtle)] p-1 pl-2.5 ${FOCUS_RING_WITHIN_INPUT_CLASS}`}
          >
            <svg
              className="icon-xs shrink-0 text-[color:var(--text-disabled)]"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <Input
              variant="seamless"
              fullWidth={false}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search models…"
              aria-label="Search models"
              className="min-w-0 flex-1 px-1 py-1 text-body"
            />
            {groups.length > 1 ? (
              <FilterMenu
                ariaLabel="Filter models by provider"
                groups={[
                  {
                    label: 'Provider',
                    items: [
                      { value: 'all', label: 'All providers' },
                      ...groups.map((group) => ({
                        value: group.providerId,
                        label: group.subscription ? `${group.providerLabel} (subscription)` : group.providerLabel,
                      })),
                    ],
                    value: activeFilter,
                    // The subscription-first default view is the baseline, not
                    // an applied filter.
                    defaultValue: defaultFilter,
                    onChange: (value) => {
                      setProviderFilter(value)
                      // Fetch the newly-selected provider's live catalog.
                      if (value !== 'all') onBrowseProvider(value)
                    },
                  },
                ]}
              />
            ) : null}
          </div>
        ) : null}
        {/* The spec's list layer on the scroller itself, unpadded: rows are
            full-bleed and the fill reaches both edges. `p-1` here wrapped
            them in the inset the menu spec retires. */}
        <div className={`min-h-0 flex-1 overflow-y-auto ${MENU_LIST_CLASS}`}>
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-meta text-[color:var(--text-muted)]" role="status">
              {normalized ? `No models match “${query.trim()}”` : 'No providers available'}
            </div>
          ) : (
            filtered.map((group) => (
              <div key={group.providerId} className="py-0.5">
                {/* The spec's group label — micro, `text.subtle`, never
                    bolder than the rows it heads (menu spec; the reasoning
                    selector is the conforming reference this now matches). */}
                <div className={`flex items-baseline gap-1.5 pb-0.5 pt-1.5 ${MENU_GROUP_LABEL_CLASS}`}>
                  <span>{group.providerLabel}</span>
                  <span className="text-micro text-[color:var(--text-subtle)]">
                    {group.unavailable
                      ? 'not available'
                      : group.subscription
                        ? 'your Claude subscription'
                        : group.emptyState === 'add-key'
                          ? 'needs an API key'
                          : 'uses your API key'}
                  </span>
                </div>
                {group.unavailable ? (
                  <p className="px-2.5 pb-1 text-micro leading-4 text-[color:var(--text-muted)]">{group.unavailable}</p>
                ) : group.models.length === 0 ? (
                  // A key-configured provider with an empty catalog stays visible
                  // with an explicit state instead of vanishing or showing a
                  // stale seed. Missing key offers a direct route to add one.
                  group.emptyState === 'add-key' ? (
                    <div className="px-2.5 pb-1.5 pt-0.5">
                      <p className="pb-1 text-micro leading-4 text-[color:var(--text-muted)]">
                        Add an API key to browse this provider’s models.
                      </p>
                      <GhostButton size="inline" tone="accent" onClick={() => onAddKey(group.providerId)}>
                        Add key in Settings
                      </GhostButton>
                    </div>
                  ) : (
                    <p
                      className="px-2.5 pb-1.5 pt-0.5 text-micro leading-4 text-[color:var(--text-muted)]"
                      role="status"
                    >
                      No models returned for this provider.
                    </p>
                  )
                ) : null}
                {group.models.map((model) => {
                  const isCurrent = group.providerId === selectedProviderId && model.id === selectedModelId
                  const jumpIndex = jumpRows.findIndex(
                    (row) => row.providerId === group.providerId && row.modelId === model.id,
                  )
                  const jumpHint = jumpIndex >= 0 && jumpIndex < 9 ? `${jumpModifier}${jumpIndex + 1}` : null
                  return (
                    // The value row primitive carries the geometry, the hover
                    // fill it suppresses while checked, the disabled state, the
                    // inset focus ring, and the `aria-checked` this role takes.
                    <MenuOption
                      key={`${group.providerId}:${model.id}`}
                      role="menuitemradio"
                      selected={isCurrent}
                      aria-keyshortcuts={
                        jumpHint
                          ? `${window.api.platform === 'darwin' ? 'Meta' : 'Control'}+${jumpIndex + 1}`
                          : undefined
                      }
                      disabled={Boolean(group.unavailable)}
                      onClick={() => onSelect(group.providerId, model.id)}
                      trailing={
                        <>
                          {/* aria-checked on the radio carries the meaning; the
                              mark inherits the selected row's ink. */}
                          {isCurrent ? <CheckIcon className="icon-xs shrink-0" /> : null}
                          {/* The spec's trailing hint: mono micro at text.disabled,
                              plain text rather than a kbd capsule. */}
                          {jumpHint ? (
                            <span
                              aria-hidden="true"
                              className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]"
                            >
                              {jumpHint}
                            </span>
                          ) : null}
                        </>
                      }
                    >
                      <TruncatedText as="span" text={model.displayName ?? model.id} className="min-w-0 flex-1" />
                    </MenuOption>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </Popover>
  )
}

export function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 5.75h14a1.75 1.75 0 0 1 1.75 1.75v7a1.75 1.75 0 0 1-1.75 1.75H10l-3.75 3v-3H5A1.75 1.75 0 0 1 3.25 15.5v-8A1.75 1.75 0 0 1 5 5.75Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function ChevronGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 7.5L10 12.5L15 7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
