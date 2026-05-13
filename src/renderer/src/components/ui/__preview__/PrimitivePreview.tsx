// Static preview surface for the shared primitive set. This is a
// reviewable design surface, not production UI. It mounts no IPC or store
// hooks; it only renders the primitives in each documented tone so reviewers
// can compare neutral, accent, good, warn, and error treatments at a glance.
//
// Render it from a developer route or scratch panel when reviewing the
// foundation. It is intentionally self-contained.

import { useState } from 'react'
import {
  DefinitionList,
  GhostButton,
  IconButton,
  InboxRow,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  Section,
  StatusDot,
  Tabs,
  TabPanel,
  type Tone,
  type ToolIdentity,
} from '../index'

const TONES: { tone: Tone; label: string; supporting: string }[] = [
  { tone: 'neutral', label: 'Neutral — idle item', supporting: 'No live state, default chrome' },
  { tone: 'accent', label: 'Accent — selected item', supporting: 'Current selection or focus target' },
  { tone: 'good', label: 'Good — running / passed', supporting: 'Live worker or passing review' },
  { tone: 'warn', label: 'Warn — needs input', supporting: 'Blocked on user, gate awaiting approval' },
  { tone: 'error', label: 'Error — failed', supporting: 'Run failed or unavailable dependency' },
]

const TOOLS: { id: ToolIdentity; label: string }[] = [
  { id: 'switchboard', label: 'Switchboard' },
  { id: 'watchtower', label: 'Watchtower' },
  { id: 'sprintengine', label: 'Sprint engine' },
  { id: 'multiloop', label: 'Multiloop' },
]

const TAB_ITEMS = [
  { id: 'inbox', label: 'Inbox', count: 4 },
  { id: 'detail', label: 'Detail' },
  { id: 'history', label: 'History', count: 12 },
  { id: 'disabled', label: 'Disabled', disabled: true },
]

export function PrimitivePreview() {
  const [selectedRow, setSelectedRow] = useState<string>('accent')
  const [tab, setTab] = useState<string>('inbox')

  return (
    <div className="flex h-full w-full flex-col gap-6 overflow-auto bg-[color:var(--bg-app)] p-6 text-[color:var(--text-default)]">
      <header className="flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold text-[color:var(--text-strong)]">
          Shared primitives — preview
        </h1>
        <p className="text-[12px] text-[color:var(--text-muted)]">
          Reference surface for the shared primitive set. Tones, tool dots, panel header, inbox
          rows, sections, definition lists, buttons, overflow menu, and tabs.
        </p>
      </header>

      <Section title="Status dots" count={TONES.length}>
        <div className="flex flex-wrap items-center gap-4">
          {TONES.map(({ tone, label }) => (
            <div key={tone} className="flex items-center gap-2">
              <StatusDot tone={tone} label={`${tone} status`} />
              <span className="text-[12px] text-[color:var(--text-default)]">{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <StatusDot tone="good" pulse label="Live good status" />
            <span className="text-[12px] text-[color:var(--text-default)]">Pulsing — live</span>
          </div>
        </div>
      </Section>

      <Section title="Tool identity dots" count={TOOLS.length}>
        <div className="flex flex-wrap items-center gap-4">
          {TOOLS.map(({ id, label }) => (
            <div key={id} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: `var(--tool-${id})` }}
              />
              <span className="text-[12px] text-[color:var(--text-default)]">{label}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Panel header">
        <div className="flex flex-col gap-3">
          {TOOLS.map(({ id, label }) => (
            <div
              key={id}
              className="overflow-hidden rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
            >
              <PanelHeader
                tool={id}
                title={label}
                subtitle="Sentence case subtitle"
                count={3}
                primaryAction={<PrimaryButton size="sm">Run</PrimaryButton>}
                overflow={
                  <OverflowMenu
                    ariaLabel={`${label} overflow`}
                    items={[
                      { id: 'settings', label: 'Settings', onSelect: () => {}, shortcut: '⌘ ,' },
                      { id: 'refresh', label: 'Refresh', onSelect: () => {} },
                      { id: 'sep', kind: 'separator' },
                      {
                        id: 'reset',
                        label: 'Reset panel',
                        destructive: true,
                        onSelect: () => {},
                      },
                    ]}
                  />
                }
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Inbox rows" count={TONES.length}>
        <div
          role="list"
          className="overflow-hidden rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]"
        >
          {TONES.map(({ tone, label, supporting }) => (
            <div role="listitem" key={tone}>
              <InboxRow
                tone={tone}
                title={label}
                supporting={supporting}
                trailing={tone === 'good' ? '02:14' : tone === 'warn' ? 'needs input' : '—'}
                selected={selectedRow === tone}
                onSelect={() => setSelectedRow(tone)}
                ariaLabel={`Preview row ${tone}`}
              />
            </div>
          ))}
        </div>
      </Section>

      <Section title="Definition list">
        <DefinitionList
          items={[
            { term: 'Source', description: 'Sprint engine state.yaml (canonical)' },
            { term: 'Owner', description: 'frontend-1' },
            { term: 'Status', description: 'In progress' },
            { term: 'Updated', description: '2 minutes ago' },
          ]}
        />
      </Section>

      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <PrimaryButton>Primary action</PrimaryButton>
          <PrimaryButton disabled>Disabled</PrimaryButton>
          <GhostButton>Ghost action</GhostButton>
          <GhostButton disabled>Disabled</GhostButton>
          <IconButton aria-label="Refresh">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M2 6a4 4 0 1 1 1.2 2.8"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path d="M2 3v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
      </Section>

      <Section title="Tabs">
        <div className="overflow-hidden rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
          <Tabs
            ariaLabel="Preview tabs"
            items={TAB_ITEMS}
            value={tab}
            onChange={setTab}
            idPrefix="preview"
          />
          <div className="p-3 text-[12px] text-[color:var(--text-default)]">
            <TabPanel idPrefix="preview" tabId="inbox" active={tab === 'inbox'}>
              Inbox panel content — composes InboxRow.
            </TabPanel>
            <TabPanel idPrefix="preview" tabId="detail" active={tab === 'detail'}>
              Detail panel content — composes DefinitionList and Section.
            </TabPanel>
            <TabPanel idPrefix="preview" tabId="history" active={tab === 'history'}>
              History panel content — composes a list of past runs.
            </TabPanel>
          </div>
        </div>
      </Section>
    </div>
  )
}

export default PrimitivePreview
