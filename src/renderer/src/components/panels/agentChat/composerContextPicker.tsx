import React, { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { WorkspaceSkill } from '../../../../../shared/electron-api'
import type { FileSearchEntry } from '../../../../../shared/ipc/filesystem'
import { detectComposerTrigger, type ComposerTrigger } from '../../../../../shared/conversation/composerTrigger'
import type { ConversationMentionRef } from '../../../../../shared/conversation/mentions'
import { rankMentionCandidates } from '../../../../../shared/conversation/searchRanking'
import {
  ChipButton,
  InlineSkillPicker,
  LinkButton,
  MenuOption,
  Popover,
  StarGlyph,
  type InlineSkillPickerHandle,
} from '../../ui'
import { SkillsAndMcpsPicker } from '../../workspace/agentComposer/SkillsAndMcpsPicker'
import { AttachmentChip } from '../../ui/AttachmentChip'
import { recentFileVisit, workspaceFileVisits } from '../../../utils/recentFileVisits'

type TriggerRange = ComposerTrigger['range']

/** Only workspace-relative references leave the picker, including parent folders. */
export function fileMentionCandidates(root: string, files: FileSearchEntry[], query: string): ConversationMentionRef[] {
  const prefix = root.replaceAll('\\', '/').replace(/\/$/u, '') + '/'
  const candidates = new Map<string, ConversationMentionRef>()
  for (const file of files) {
    const normalized = file.path.replaceAll('\\', '/')
    const path = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized
    if (!path || path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path.split('/').includes('..')) continue
    candidates.set(path, { path, kind: file.isDir ? 'folder' : 'file' })
    const parts = path.split('/')
    parts.pop()
    while (parts.length) {
      const parent = parts.join('/')
      candidates.set(parent, { path: parent, kind: 'folder' })
      parts.pop()
    }
  }
  return rankMentionCandidates(
    [...candidates.values()].map((candidate) => ({
      ...candidate,
      recentAt: recentFileVisit(prefix + candidate.path),
    })),
    query,
    50,
  ).map(({ path, kind }) => ({ path, kind }))
}

export function useFileMentionSearch(workspaceRoot: string | null, query: string | null) {
  const channel = `mention:${useId()}`
  const [state, setState] = useState<{ rows: ConversationMentionRef[]; loading: boolean; error: string | null }>({
    rows: [],
    loading: false,
    error: null,
  })
  useEffect(() => {
    let cancelled = false
    let started = false
    setState({ rows: [], loading: Boolean(workspaceRoot && query?.trim()), error: null })
    if (!workspaceRoot || query === null || !query.trim()) return
    const timer = window.setTimeout(() => {
      started = true
      void window.api
        .searchFiles(workspaceRoot, query, {
          limit: 50,
          purpose: 'mention',
          channel,
          recentAt: workspaceFileVisits(workspaceRoot),
        })
        .then((result) => {
          if (cancelled) return
          setState(
            result.ok
              ? { rows: fileMentionCandidates(workspaceRoot, result.results, query), loading: false, error: null }
              : { rows: [], loading: false, error: result.message },
          )
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({ rows: [], loading: false, error: error instanceof Error ? error.message : String(error) })
        })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (started) void window.api.cancelFileSearch?.(channel).catch(() => undefined)
    }
  }, [query, workspaceRoot, channel])
  return state
}

const InlineMentionPicker = forwardRef<
  InlineSkillPickerHandle,
  {
    workspaceRoot: string | null
    query: string
    onPick: (mention: ConversationMentionRef) => void
    onDismiss: () => void
  }
>(function InlineMentionPicker({ workspaceRoot, query, onPick, onDismiss }, ref) {
  const { rows, loading, error } = useFileMentionSearch(workspaceRoot, query)
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const active = Math.min(activeIndex, Math.max(0, rows.length - 1))
  useEffect(() => setActiveIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])
  useImperativeHandle(
    ref,
    () => ({
      moveSelection(delta) {
        setActiveIndex((current) => Math.max(0, Math.min(rows.length - 1, current + delta)))
        return rows.length > 0
      },
      pickActive() {
        const row = rows[active]
        if (!row) return false
        onPick(row)
        return true
      },
      matchCount: () => rows.length,
    }),
    [active, onPick, rows],
  )
  return (
    <div className="pointer-events-none absolute inset-0 flex">
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) onDismiss()
        }}
        ariaLabel="Mention a workspace file"
        popupRole="listbox"
        placement="top-start"
        material="glass"
        className="w-full"
        renderTrigger={() => null}
        surfaceClassName="w-[var(--popover-trigger-width)]"
      >
        <div ref={listRef} id={listId} className="max-h-64 overflow-y-auto py-1">
          {loading || error || rows.length === 0 ? (
            <p role="status" className="px-3 py-2 text-meta text-[color:var(--text-muted)]">
              {error ??
                (loading ? 'Searching files…' : query ? 'No matching workspace files.' : 'Type a file or folder name.')}
            </p>
          ) : null}
          {rows.map((row, index) => (
            <MenuOption
              key={`${row.kind}:${row.path}`}
              role="option"
              selected={index === active}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => onPick(row)}
              trailing={row.kind === 'folder' ? 'Folder' : undefined}
            >
              {row.path}
            </MenuOption>
          ))}
        </div>
        <div className="border-t border-[color:var(--border-subtle)] px-3 py-1.5 text-micro text-[color:var(--text-subtle)]">
          ↑↓ choose · enter or tab attach · esc dismiss
        </div>
      </Popover>
    </div>
  )
})

export function useComposerContextPicker({
  workspaceRoot,
  draft,
  caret,
  skillsEnabled,
  onPickSkill,
  onPickMention,
}: {
  workspaceRoot: string | null
  draft: string
  caret: number
  skillsEnabled: boolean
  onPickSkill: (skill: WorkspaceSkill, range: TriggerRange) => void
  onPickMention: (mention: ConversationMentionRef, range: TriggerRange) => void
}) {
  const detected = useMemo(() => detectComposerTrigger(draft, caret), [draft, caret])
  const triggerKey = detected
    ? `${detected.kind}:${detected.range.start}:${detected.range.end}:${detected.query}`
    : null
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)
  useEffect(() => setDismissedKey(null), [triggerKey])
  const trigger =
    detected && triggerKey !== dismissedKey && (detected.kind === 'mention' || skillsEnabled) ? detected : null
  const pickerRef = useRef<InlineSkillPickerHandle>(null)
  const dismiss = useCallback(() => setDismissedKey(triggerKey), [triggerKey])
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!trigger || event.nativeEvent.isComposing) return false
      if (event.key === 'Escape') dismiss()
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        pickerRef.current?.moveSelection(event.key === 'ArrowUp' ? -1 : 1)
      else if (event.key === 'Enter' || event.key === 'Tab') pickerRef.current?.pickActive()
      else return false
      event.preventDefault()
      event.stopPropagation()
      return true
    },
    [dismiss, trigger],
  )
  const picker =
    trigger?.kind === 'mention' ? (
      <InlineMentionPicker
        ref={pickerRef}
        workspaceRoot={workspaceRoot}
        query={trigger.query}
        onPick={(mention) => onPickMention(mention, trigger.range)}
        onDismiss={dismiss}
      />
    ) : trigger ? (
      <InlineSkillPicker
        ref={pickerRef}
        workspaceRoot={workspaceRoot}
        pluginId={null}
        query={trigger.query}
        onPick={(skill) => onPickSkill(skill, trigger.range)}
        onDismiss={dismiss}
      />
    ) : null
  return { trigger, pickerRef, handleKeyDown, dismiss, picker }
}

export function ComposerSkillsPicker({
  workspaceRoot,
  skills,
  onSkillsChange,
}: {
  workspaceRoot: string | null
  skills: WorkspaceSkill[]
  onSkillsChange: (skills: WorkspaceSkill[]) => void
}) {
  return (
    <SkillsAndMcpsPicker
      workspaceRoot={workspaceRoot}
      pluginId={null}
      skills={skills}
      onSkillsChange={onSkillsChange}
      mcpServers={[]}
      onMcpServersChange={() => undefined}
      includeMcps={false}
      placement="top-start"
    />
  )
}

function SkillContextChip({
  skill,
  onRemove,
  onOpen,
}: {
  skill: WorkspaceSkill
  onRemove: () => void
  onOpen: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <AttachmentChip label={skill.name} removeLabel={`Remove ${skill.name}`} onRemove={onRemove}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        ariaLabel={skill.name}
        popupRole="dialog"
        placement="top-start"
        renderTrigger={({ ref, triggerProps, togglePopover }) => (
          <ChipButton
            ref={ref}
            {...triggerProps}
            variant="outline"
            onMouseEnter={() => setOpen(true)}
            onClick={togglePopover}
          >
            <StarGlyph filled={false} className="icon-xs" />
            {skill.name}
          </ChipButton>
        )}
      >
        <div className="max-w-xs space-y-2 p-3 text-meta">
          <p className="font-medium">{skill.name}</p>
          {skill.description ? <p>{skill.description}</p> : null}
          <p className="text-[color:var(--text-muted)]">
            {skill.source} · {skill.installState === 'available' ? 'Available to install' : 'Installed'}
          </p>
          <LinkButton
            onClick={() => {
              setOpen(false)
              onOpen()
            }}
          >
            Open skill
          </LinkButton>
        </div>
      </Popover>
    </AttachmentChip>
  )
}

export function ComposerContextChips({
  skills,
  mentions,
  onRemoveSkill,
  onRemoveMention,
  onOpenSkill,
}: {
  skills: WorkspaceSkill[]
  mentions: ConversationMentionRef[]
  onRemoveSkill: (id: string) => void
  onRemoveMention: (mention: ConversationMentionRef) => void
  onOpenSkill: (skill: WorkspaceSkill) => void
}) {
  if (skills.length === 0 && mentions.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2" aria-label="Attached context">
      {skills.map((skill) => (
        <SkillContextChip
          key={skill.id}
          skill={skill}
          onRemove={() => onRemoveSkill(skill.id)}
          onOpen={() => onOpenSkill(skill)}
        />
      ))}
      {mentions.map((mention) => (
        <AttachmentChip
          key={`${mention.kind}:${mention.path}`}
          label={mention.path + (mention.kind === 'folder' ? '/' : '')}
          removeLabel={`Remove ${mention.path}`}
          onRemove={() => onRemoveMention(mention)}
        />
      ))}
    </div>
  )
}
