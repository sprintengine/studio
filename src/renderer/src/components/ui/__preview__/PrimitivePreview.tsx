// Static preview surface for the shared primitive set. This is a
// reviewable design surface, not production UI. It mounts no IPC or store
// hooks; it only renders the primitives in each documented tone so reviewers
// can compare neutral, accent, good, warn, and error treatments at a glance.
//
// Render it from a developer route or scratch panel when reviewing the
// foundation. It is intentionally self-contained.

import { useState } from 'react'
import type { SprintEngineRole } from '../../../types/workspace'
import {
  DefinitionList,
  Drawer,
  Field,
  GhostButton,
  IconButton,
  InboxRow,
  Input,
  KbdChord,
  OverflowMenu,
  PanelHeader,
  PrimaryButton,
  RoleGlyph,
  Section,
  Select,
  type SelectItem,
  StatusDot,
  Switch,
  Tabs,
  TabPanel,
  Textarea,
  Toast,
  Tooltip,
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
  { id: 'sprintengine', label: 'Sprint engine' },
]

const TAB_ITEMS = [
  { id: 'inbox', label: 'Inbox', count: 4 },
  { id: 'detail', label: 'Detail' },
  { id: 'history', label: 'History', count: 12 },
  { id: 'disabled', label: 'Disabled', disabled: true },
]

type RoleOption = 'architect' | 'frontend' | 'security' | 'performance' | 'tester'

const SELECT_ROLE_ITEMS: SelectItem<RoleOption>[] = [
  { value: 'architect', label: 'Architect' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'security', label: 'Security' },
  { value: 'performance', label: 'Performance' },
  { value: 'tester', label: 'Tester', disabled: true },
]

type ThemeOption = 'auto' | 'dark' | 'light'

const SELECT_THEME_ITEMS: SelectItem<ThemeOption>[] = [
  { value: 'auto', label: 'Match system' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const ROLE_GLYPHS: SprintEngineRole[] = [
  'architect',
  'product',
  'frontend',
  'ui_ux_reviewer',
  'developer',
  'cross_platform',
  'tester',
  'security',
  'performance',
  'production_readiness_reviewer',
]

const KBD_CHORDS: { keys: readonly string[]; ariaLabel: string; supporting: string }[] = [
  { keys: ['⌘', 'K'], ariaLabel: 'Command K', supporting: 'Open command palette' },
  { keys: ['⌘', 'Shift', 'P'], ariaLabel: 'Command Shift P', supporting: 'Run last command' },
  { keys: ['Esc'], ariaLabel: 'Escape', supporting: 'Dismiss the overlay' },
]

export function PrimitivePreview() {
  const [selectedRow, setSelectedRow] = useState<string>('accent')
  const [tab, setTab] = useState<string>('inbox')
  const [notify, setNotify] = useState(true)
  const [autoRun, setAutoRun] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('linear-grade-audit')
  const [endpoint, setEndpoint] = useState('')
  const [role, setRole] = useState<RoleOption>('frontend')
  const [theme, setTheme] = useState<ThemeOption>('auto')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [toastVisible, setToastVisible] = useState(true)

  return (
    <div className="flex h-full w-full flex-col gap-6 overflow-auto bg-[color:var(--bg-app)] p-6 text-[color:var(--text-default)]">
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold text-[color:var(--text-strong)]">
          Shared primitives — preview
        </h1>
        <p className="text-meta text-[color:var(--text-muted)]">
          Reference surface for the shared primitive set. Tones, tool dots, panel header, inbox
          rows, sections, definition lists, buttons, overflow menu, and tabs.
        </p>
      </header>

      <Section title="Status dots" count={TONES.length}>
        <div className="flex flex-wrap items-center gap-4">
          {TONES.map(({ tone, label }) => (
            <div key={tone} className="flex items-center gap-2">
              <StatusDot tone={tone} label={`${tone} status`} />
              <span className="text-meta text-[color:var(--text-default)]">{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <StatusDot tone="good" pulse label="Live good status" />
            <span className="text-meta text-[color:var(--text-default)]">Pulsing — live</span>
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
              <span className="text-meta text-[color:var(--text-default)]">{label}</span>
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
            { term: 'Source', description: 'sprint projection (canonical)' },
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

      <Section title="Switch">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <Switch
              checked={notify}
              onChange={setNotify}
              ariaLabel="Send completion notifications"
            />
            <span className="text-meta text-[color:var(--text-default)]">
              Send completion notifications
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked={autoRun} onChange={setAutoRun} ariaLabel="Auto-run on workspace open" />
            <span className="text-meta text-[color:var(--text-default)]">
              Auto-run on workspace open
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Switch checked disabled onChange={() => {}} ariaLabel="Disabled checked switch" />
            <span className="text-meta text-[color:var(--text-muted)]">
              Disabled — managed elsewhere
            </span>
          </div>
        </div>
      </Section>

      <Section title="Field">
        <div className="flex flex-col gap-4">
          {/* The preview used to hand-roll its own `h-7` field three times —
              the kit demonstrating the exact drift it exists to prevent. */}
          <Field label="Workspace name" htmlFor="preview-field-name" required>
            <Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
          </Field>
          <Field
            label="Webhook endpoint"
            htmlFor="preview-field-endpoint"
            help="Optional — leave blank to disable outbound notifications."
          >
            <Input
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://"
              size="md"
            />
          </Field>
          <Field
            label="API key"
            htmlFor="preview-field-key"
            error="Required when the webhook endpoint is set."
            required
          >
            <Input defaultValue="" className="border-[color:var(--tone-error)]" />
          </Field>
          <Field label="Command override" htmlFor="preview-field-well" help="The recessed step, for a control sitting in a settings row.">
            <Input defaultValue="" variant="well" size="md" className="font-mono" />
          </Field>
          <Field label="Release note" htmlFor="preview-field-notes" help="The multiline member of the same vocabulary.">
            <Textarea defaultValue="" rows={3} placeholder="What changed, and why it matters." />
          </Field>
        </div>
      </Section>

      <Section title="Select">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-meta text-[color:var(--text-muted)]">Worker role</span>
            <Select
              ariaLabel="Worker role"
              items={SELECT_ROLE_ITEMS}
              value={role}
              onChange={setRole}
              className="w-[220px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-meta text-[color:var(--text-muted)]">Theme</span>
            <Select
              ariaLabel="Theme"
              items={SELECT_THEME_ITEMS}
              value={theme}
              onChange={setTheme}
              className="w-[180px]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-meta text-[color:var(--text-muted)]">Disabled — managed elsewhere</span>
            <Select
              ariaLabel="Disabled select"
              items={SELECT_THEME_ITEMS}
              value={null}
              onChange={() => {}}
              disabled
              placeholder="Locked"
              className="w-[180px]"
            />
          </div>
        </div>
      </Section>

      <Section title="Drawer">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={() => setDrawerOpen(true)}>Open drawer</PrimaryButton>
            <span className="text-meta text-[color:var(--text-muted)]">
              Escape closes; focus returns to the trigger.
            </span>
          </div>
          <Drawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            title="Drawer preview"
            ariaLabel="Drawer preview"
          >
            <Drawer.Body>
              <div className="flex flex-col gap-3">
                <DefinitionList
                  items={[
                    { term: 'Pattern', description: 'Right-slide-in, panel-local dialog' },
                    { term: 'Elevation', description: '--shadow-drawer (canonical)' },
                    { term: 'Motion', description: 'translate3d, --motion-deliberate' },
                    { term: 'Reduced motion', description: 'Slide skipped; transform jumps' },
                  ]}
                />
                <div className="flex items-center gap-2">
                  <GhostButton onClick={() => setDrawerOpen(false)}>Close</GhostButton>
                  <PrimaryButton onClick={() => setDrawerOpen(false)}>Acknowledge</PrimaryButton>
                </div>
              </div>
            </Drawer.Body>
          </Drawer>
        </div>
      </Section>

      <Section title="Toast">
        <div className="flex max-w-md flex-col gap-2">
          <Toast tone="neutral" title="Workspace saved" description="Last write 12:04 PM" />
          <Toast
            tone="good"
            title="Build passed"
            description="42 packages compiled in 8.6s — auto-dismiss in 5s."
          />
          <Toast
            tone="warn"
            title="Branch is behind main"
            description="Pull before pushing. This toast stays until dismissed."
            onDismiss={() => undefined}
          />
          <Toast
            tone="error"
            title="Lint failed"
            description="3 violations in AgentChatView.tsx."
            onDismiss={() => undefined}
          />
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => setToastVisible((v) => !v)}>
              {toastVisible ? 'Hide programmatic toast' : 'Show programmatic toast'}
            </GhostButton>
            {toastVisible ? (
              <Toast
                tone="accent"
                title="Saved as preset"
                onDismiss={() => setToastVisible(false)}
              />
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="Tooltip">
        <div className="flex flex-wrap items-center gap-6">
          <Tooltip content="Refresh the workspace state">
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
          </Tooltip>
          <Tooltip content="Discard local changes" placement="bottom">
            <GhostButton>Reset</GhostButton>
          </Tooltip>
          <Tooltip content="Sprint engine state is the source of truth">
            <span className="text-meta text-[color:var(--text-muted)] underline decoration-dotted underline-offset-2">
              Source
            </span>
          </Tooltip>
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
          <div className="p-3 text-meta text-[color:var(--text-default)]">
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

      <Section title="Keyboard chords" count={KBD_CHORDS.length}>
        <div className="flex flex-col gap-2">
          {KBD_CHORDS.map((chord) => (
            <div key={chord.ariaLabel} className="flex items-center gap-3">
              <KbdChord keys={chord.keys} ariaLabel={chord.ariaLabel} />
              <span className="text-meta text-[color:var(--text-muted)]">{chord.supporting}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Role glyphs" count={ROLE_GLYPHS.length}>
        <p className="mb-3 text-meta text-[color:var(--text-muted)]">
          Documented exception to the one-accent rule. Used only on the Sprint Engine kanban card,
          task-graph nodes, and agent rows where role tone carries identity information.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          {ROLE_GLYPHS.map((roleId) => (
            <div key={roleId} className="flex items-center gap-2">
              <RoleGlyph role={roleId} size="md" />
              <span className="text-meta text-[color:var(--text-default)]">{roleId}</span>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-4">
          <div className="flex items-center gap-2">
            <RoleGlyph role="frontend" size="sm" />
            <span className="text-micro text-[color:var(--text-muted)]">sm</span>
          </div>
          <div className="flex items-center gap-2">
            <RoleGlyph role="frontend" size="md" />
            <span className="text-micro text-[color:var(--text-muted)]">md</span>
          </div>
          <div className="flex items-center gap-2">
            <RoleGlyph role="frontend" size="lg" />
            <span className="text-micro text-[color:var(--text-muted)]">lg</span>
          </div>
        </div>
      </Section>
    </div>
  )
}

export default PrimitivePreview
