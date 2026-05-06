import React from 'react'
import type {
  MemoryGraphColorRule,
  MemoryGraphDisplayConfig,
  MemoryGraphFiltersConfig,
  MemoryGraphForcesConfig,
  MemoryGraphSettings,
} from '../../types/workspace'
import {
  DEFAULT_DISPLAY,
  DEFAULT_FILTERS,
  DEFAULT_FORCES,
  GRAPH_PALETTE,
  ruleId,
  SidebarTab,
} from './memoryGraphTypes'

type Props = {
  settings: MemoryGraphSettings
  groups: string[]
  onSettingsChange: (
    update:
      | Partial<MemoryGraphSettings>
      | ((current: MemoryGraphSettings) => Partial<MemoryGraphSettings> | MemoryGraphSettings)
  ) => void
  onClose: () => void
}

export default function MemoryGraphSidebar({ settings, groups, onSettingsChange, onClose }: Props) {
  const setTab = (tab: SidebarTab) => onSettingsChange({ activeTab: tab })

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l border-zinc-800 bg-zinc-900">
      <div className="flex items-stretch border-b border-zinc-800 px-1">
        <SidebarTabButton label="Filters" active={settings.activeTab === 'filters'} onClick={() => setTab('filters')} />
        <SidebarTabButton label="Groups" active={settings.activeTab === 'groups'} onClick={() => setTab('groups')} />
        <SidebarTabButton label="Display" active={settings.activeTab === 'display'} onClick={() => setTab('display')} />
        <SidebarTabButton label="Forces" active={settings.activeTab === 'forces'} onClick={() => setTab('forces')} />
        <button
          type="button"
          onClick={onClose}
          className="ml-1 flex h-[34px] w-[26px] items-center justify-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          title="Close sidebar"
          aria-label="Close sidebar"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 pb-4 pt-3">
        {settings.activeTab === 'filters' ? (
          <FiltersTab
            filters={settings.filters}
            colorRules={settings.colorRules}
            groups={groups}
            onChange={(filters) => onSettingsChange({ filters })}
          />
        ) : settings.activeTab === 'groups' ? (
          <GroupsTab
            colorRules={settings.colorRules}
            groups={groups}
            onChange={(colorRules) => onSettingsChange({ colorRules })}
          />
        ) : settings.activeTab === 'display' ? (
          <DisplayTab
            display={settings.display}
            onChange={(display) => onSettingsChange({ display })}
          />
        ) : (
          <ForcesTab
            forces={settings.forces}
            onChange={(forces) => onSettingsChange({ forces })}
          />
        )}
      </div>
    </aside>
  )
}

function SidebarTabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-[34px] flex-1 text-[11px] transition-colors ${
        active ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {label}
      {active ? (
        <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-indigo-500" aria-hidden />
      ) : null}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters

function FiltersTab({
  filters,
  colorRules,
  groups,
  onChange,
}: {
  filters: MemoryGraphFiltersConfig
  colorRules: MemoryGraphColorRule[]
  groups: string[]
  onChange: (filters: MemoryGraphFiltersConfig) => void
}) {
  const toggleGroup = (group: string) => {
    const isDisabled = filters.disabledGroups.includes(group)
    onChange({
      ...filters,
      disabledGroups: isDisabled
        ? filters.disabledGroups.filter((g) => g !== group)
        : [...filters.disabledGroups, group],
    })
  }

  return (
    <div className="space-y-5">
      <Section label="Visibility">
        <ToggleRow
          label="Hide orphans"
          on={filters.hideOrphans}
          onChange={(value) => onChange({ ...filters, hideOrphans: value })}
        />
        <ToggleRow
          label="Hide attachments"
          on={filters.hideAttachments}
          onChange={(value) => onChange({ ...filters, hideAttachments: value })}
        />
        <ToggleRow
          label="Hide unresolved"
          on={filters.hideUnresolved}
          onChange={(value) => onChange({ ...filters, hideUnresolved: value })}
        />
      </Section>

      <Section label="Depth from selection">
        <div className="flex gap-1">
          {[1, 2, 3, 4, null].map((depth) => {
            const value = depth ?? 'all'
            const active = filters.depthFromSelection === depth
            return (
              <button
                key={String(value)}
                type="button"
                onClick={() => onChange({ ...filters, depthFromSelection: depth })}
                className={`h-6 flex-1 rounded font-mono text-[11px] transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'border border-zinc-800 bg-zinc-900 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                }`}
              >
                {depth ?? '∞'}
              </button>
            )
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-zinc-500">
          Limits the graph to neighbors within N hops of the selected note. Has no effect when nothing is selected.
        </p>
      </Section>

      {groups.length > 0 ? (
        <Section label="Filter by group">
          <div className="space-y-1">
            {groups.map((group) => {
              const rule = colorRules.find((r) =>
                r.pattern.replace(/^path:/i, '').replace(/\/+$/u, '').toLowerCase()
                  === group.toLowerCase()
              )
              const isDisabled = filters.disabledGroups.includes(group)
              return (
                <ToggleRow
                  key={group}
                  label={
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: rule?.color ?? '#52525b' }}
                      />
                      <span className="truncate">{group}</span>
                    </span>
                  }
                  on={!isDisabled}
                  onChange={() => toggleGroup(group)}
                />
              )
            })}
          </div>
        </Section>
      ) : null}

      <button
        type="button"
        onClick={() => onChange(DEFAULT_FILTERS)}
        className="w-full rounded border border-dashed border-zinc-700 bg-transparent px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      >
        Reset filters
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Groups

function GroupsTab({
  colorRules,
  groups,
  onChange,
}: {
  colorRules: MemoryGraphColorRule[]
  groups: string[]
  onChange: (rules: MemoryGraphColorRule[]) => void
}) {
  const updateRule = (id: string, patch: Partial<MemoryGraphColorRule>) => {
    onChange(colorRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)))
  }
  const removeRule = (id: string) => {
    onChange(colorRules.filter((rule) => rule.id !== id))
  }
  const addRule = () => {
    const used = new Set(colorRules.map((r) => r.color))
    const nextColor = GRAPH_PALETTE.find((c) => !used.has(c)) ?? GRAPH_PALETTE[colorRules.length % GRAPH_PALETTE.length]
    onChange([...colorRules, { id: ruleId(), pattern: '', color: nextColor }])
  }
  const seedFromGroups = () => {
    const seeded = groups.map((group, idx) => ({
      id: ruleId(),
      pattern: `path:${group}/`,
      color: GRAPH_PALETTE[idx % GRAPH_PALETTE.length],
    }))
    onChange(seeded)
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Color rules</p>
        <p className="text-[11px] leading-5 text-zinc-500">
          First match wins. Use <span className="font-mono text-zinc-300">path:foo/</span> to color all
          notes under <span className="font-mono text-zinc-300">foo/</span>.
        </p>
      </div>

      <div className="space-y-1.5">
        {colorRules.map((rule) => (
          <div
            key={rule.id}
            className="flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5"
          >
            <ColorSwatch
              color={rule.color}
              onChange={(color) => updateRule(rule.id, { color })}
            />
            <input
              type="text"
              value={rule.pattern}
              onChange={(event) => updateRule(rule.id, { pattern: event.target.value })}
              placeholder="path:folder/"
              className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => removeRule(rule.id)}
              className="text-zinc-600 transition-colors hover:text-zinc-300"
              aria-label="Remove color rule"
              title="Remove"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={addRule}
        className="flex w-full items-center justify-center gap-1.5 rounded border border-dashed border-zinc-700 bg-transparent px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      >
        + Add color rule
      </button>

      {colorRules.length === 0 && groups.length > 0 ? (
        <button
          type="button"
          onClick={seedFromGroups}
          className="w-full rounded bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700"
        >
          Seed rules from {groups.length} top-level folder{groups.length === 1 ? '' : 's'}
        </button>
      ) : null}
    </div>
  )
}

function ColorSwatch({ color, onChange }: { color: string; onChange: (color: string) => void }) {
  return (
    <label className="relative inline-flex h-3 w-3 shrink-0 cursor-pointer">
      <span
        className="block h-3 w-3 rounded-full ring-1 ring-inset ring-zinc-700"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <input
        type="color"
        value={color}
        onChange={(event) => onChange(event.target.value)}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-label="Pick color"
      />
    </label>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Display

function DisplayTab({
  display,
  onChange,
}: {
  display: MemoryGraphDisplayConfig
  onChange: (display: MemoryGraphDisplayConfig) => void
}) {
  return (
    <div className="space-y-4">
      <SliderRow
        label="Node size"
        value={display.nodeSizeScale}
        min={0.5}
        max={2.5}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(value) => onChange({ ...display, nodeSizeScale: value })}
      />
      <SliderRow
        label="Line thickness"
        value={display.lineThicknessScale}
        min={0.5}
        max={2.5}
        step={0.05}
        format={(v) => `${v.toFixed(2)}×`}
        onChange={(value) => onChange({ ...display, lineThicknessScale: value })}
      />
      <SliderRow
        label="Label fade"
        value={display.labelFadeThreshold}
        min={0}
        max={1.5}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(value) => onChange({ ...display, labelFadeThreshold: value })}
      />
      <SliderRow
        label="Label size"
        value={display.labelFontSize}
        min={9}
        max={18}
        step={1}
        format={(v) => `${v}px`}
        onChange={(value) => onChange({ ...display, labelFontSize: value })}
      />

      <div className="space-y-1 pt-2">
        <ToggleRow
          label="Curved edges"
          on={display.curvedEdges}
          onChange={(value) => onChange({ ...display, curvedEdges: value })}
        />
        <ToggleRow
          label="Glow halos"
          on={display.glowHalos}
          onChange={(value) => onChange({ ...display, glowHalos: value })}
        />
        <ToggleRow
          label="Show arrows"
          on={display.showArrows}
          onChange={(value) => onChange({ ...display, showArrows: value })}
        />
        <ToggleRow
          label={
            <span className="flex items-center gap-1.5">
              <span>Twinkling stars</span>
              <span className="text-[10px] text-zinc-600">space</span>
            </span>
          }
          on={display.starfield}
          onChange={(value) => onChange({ ...display, starfield: value })}
        />
      </div>

      <button
        type="button"
        onClick={() => onChange(DEFAULT_DISPLAY)}
        className="w-full rounded border border-dashed border-zinc-700 bg-transparent px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      >
        Restore defaults
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Forces

function ForcesTab({
  forces,
  onChange,
}: {
  forces: MemoryGraphForcesConfig
  onChange: (forces: MemoryGraphForcesConfig) => void
}) {
  return (
    <div className="space-y-4">
      <SliderRow
        label="Center force"
        value={forces.centerForce}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(value) => onChange({ ...forces, centerForce: value })}
      />
      <SliderRow
        label="Repel force"
        value={forces.repelForce}
        min={0}
        max={2}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(value) => onChange({ ...forces, repelForce: value })}
      />
      <SliderRow
        label="Link force"
        value={forces.linkForce}
        min={0}
        max={1}
        step={0.01}
        format={(v) => v.toFixed(2)}
        onChange={(value) => onChange({ ...forces, linkForce: value })}
      />
      <SliderRow
        label="Link distance"
        value={forces.linkDistance}
        min={20}
        max={240}
        step={2}
        format={(v) => `${Math.round(v)}px`}
        onChange={(value) => onChange({ ...forces, linkDistance: value })}
      />

      <button
        type="button"
        onClick={() => onChange(DEFAULT_FORCES)}
        className="w-full rounded border border-dashed border-zinc-700 bg-transparent px-2 py-1.5 text-[11px] text-zinc-400 transition-colors hover:border-zinc-600 hover:text-zinc-200"
      >
        Restore defaults
      </button>

      <p className="text-[11px] leading-5 text-zinc-500">
        Drag a node to pin it. Double-click a pinned node to release.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
      <div className="space-y-1">{children}</div>
    </section>
  )
}

function ToggleRow({
  label,
  on,
  onChange,
}: {
  label: React.ReactNode
  on: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="flex w-full items-center justify-between gap-2 rounded px-1 py-1 text-left text-[12px] text-zinc-300 transition-colors hover:bg-zinc-800/60"
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        aria-hidden
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          on ? 'bg-indigo-600' : 'bg-zinc-700'
        }`}
      >
        <span
          className={`absolute h-3 w-3 rounded-full bg-zinc-100 transition-all ${
            on ? 'left-[14px]' : 'left-[2px]'
          }`}
        />
      </span>
    </button>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (value: number) => string
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-[12px] text-zinc-300">
        <span>{label}</span>
        <span className="font-mono text-[11px] text-zinc-500">{format(value)}</span>
      </div>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
        className="memory-graph-slider mt-1 block h-1 w-full appearance-none rounded-full bg-zinc-800 accent-indigo-500 outline-none"
      />
    </label>
  )
}
