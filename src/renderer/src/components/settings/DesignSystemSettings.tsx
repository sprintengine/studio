import { useCallback, useEffect, useState } from 'react'
import type { DesignSystemAttachSource } from '../../../../shared/design-system/attach'
import { DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME } from '../../../../shared/design-system/bundle-scaffold'
import type { DesignSystemBundleReadFailure } from '../../../../shared/design-system/bundle-view'
import type { DesignSystemLibraryEntry } from '../../../../shared/design-system/library'
import { GhostButton, InlineNotice, OutlineButton, PrimaryButton, SettingCard } from '../ui'
import { useConfirmDialog } from '../ui/ConfirmDialog'
import { DesignSystemAttachStep } from '../workspace/newWorkspace/DesignSystemAttachStep'
import { pathJoin } from '../../utils/paths'
import {
  BUNDLE_ORIGIN_LABEL,
  findLibraryUpdate,
  resolveBundleOrigin,
  type DesignSystemBundleOrigin,
} from './designSystemSettingsModel'

// The Settings design-system section (item 1950): the after-creation half of
// what newWorkspace/DesignSystemAttachStep starts. State derives from disk —
// design-system/ existing IS the configuration the launch prompt reads — so
// this surface stores nothing and re-reads after every mutation. Attach and
// replace go through the same attach IPC as the wizard; nothing here copies.

type BundleState =
  | { kind: 'probing' }
  /** No design-system/ in the workspace — the attachable state. */
  | { kind: 'none' }
  | {
      kind: 'attached'
      name: string
      version: string
      componentCount: number
      patternCount: number
      origin: DesignSystemBundleOrigin
    }
  /** design-system/ exists but cannot be read as a bundle. */
  | { kind: 'broken'; reason: DesignSystemBundleReadFailure; message: string }

type PendingAction = 'attach' | 'detach' | 'update' | null

export function DesignSystemSettings({ workspaceRoot }: { workspaceRoot: string | null }) {
  const dialog = useConfirmDialog()
  const [bundle, setBundle] = useState<BundleState>({ kind: 'probing' })
  const [libraryEntries, setLibraryEntries] = useState<DesignSystemLibraryEntry[]>([])
  const [pending, setPending] = useState<PendingAction>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerSelection, setPickerSelection] = useState<DesignSystemAttachSource | null>(null)
  // Bumped after every mutation so the disk probe re-runs.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    setBundle({ kind: 'probing' })
    if (!workspaceRoot) return
    void window.api
      .readDesignSystemBundle(pathJoin(workspaceRoot, DESIGN_SYSTEM_BUNDLE_DIRECTORY_NAME))
      .then((result) => {
        if (cancelled) return
        if (result.ok) {
          setBundle({
            kind: 'attached',
            name: result.view.identity.name,
            version: result.view.identity.version,
            componentCount: result.view.components.length,
            patternCount: result.view.patterns.length,
            origin: resolveBundleOrigin(result.view.manifest.provenance),
          })
        } else if (result.reason === 'missing') {
          setBundle({ kind: 'none' })
        } else {
          setBundle({ kind: 'broken', reason: result.reason, message: result.message })
        }
      })
      .catch((error) => {
        if (cancelled) return
        setBundle({
          kind: 'broken',
          reason: 'unreadable',
          message: error instanceof Error ? error.message : String(error),
        })
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot, reloadKey])

  useEffect(() => {
    let cancelled = false
    void window.api
      .listDesignSystemLibrary()
      .then((result) => {
        if (!cancelled) setLibraryEntries(result.entries)
      })
      // The library being unreadable only costs the update affordance; the
      // attach picker reports its own read failure.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [reloadKey])

  // Re-probes disk without touching `message`: callers own error text, and a
  // failed step must stay on screen while the state underneath it refreshes.
  const reload = useCallback(() => {
    setReloadKey((key) => key + 1)
  }, [])

  const detach = useCallback(
    async (confirm: { title: string; body: string; confirmLabel: string }): Promise<boolean> => {
      if (!workspaceRoot) return false
      const confirmed = await dialog.confirm({ ...confirm, tone: 'danger' })
      if (!confirmed) return false
      setPending('detach')
      setMessage(null)
      try {
        const result = await window.api.detachDesignSystemBundle(workspaceRoot)
        if (!result.ok) {
          setMessage(result.message)
          return false
        }
        return true
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
        return false
      } finally {
        setPending(null)
      }
    },
    [dialog, workspaceRoot],
  )

  const onDetach = useCallback(async () => {
    const authored = bundle.kind === 'attached' && bundle.origin === 'authored'
    const removed = await detach({
      title: 'Detach this design system?',
      body: authored
        ? 'This bundle was created in this project — deleting design-system/ removes its source, not a copy. Agents launched here will no longer be told to conform to it.'
        : 'Deletes design-system/ from this project, including any local edits. Agents launched here will no longer be told to conform to it.',
      confirmLabel: 'Detach',
    })
    if (removed) reload()
  }, [bundle, detach, reload])

  const onReplace = useCallback(async () => {
    const removed = await detach({
      title: 'Replace the attached design system?',
      body: 'Deletes the current design-system/ copy, including any local edits, then lets you choose what to attach instead.',
      confirmLabel: 'Remove and choose',
    })
    if (removed) {
      setPickerSelection(null)
      setPickerOpen(true)
      reload()
    }
  }, [detach, reload])

  const runAttach = useCallback(
    async (source: DesignSystemAttachSource, action: Exclude<PendingAction, null>) => {
      if (!workspaceRoot) return
      setPending(action)
      setMessage(null)
      try {
        const result = await window.api.attachDesignSystemBundle(source, workspaceRoot)
        if (result.ok) {
          setPickerOpen(false)
          setPickerSelection(null)
        } else {
          setMessage(result.message)
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
      } finally {
        setPending(null)
        // Always re-probe: an update that detached and then failed to attach
        // must show the truthful empty state, not the stale card.
        reload()
      }
    },
    [reload, workspaceRoot],
  )

  const onUpdate = useCallback(
    async (entry: DesignSystemLibraryEntry) => {
      const confirmed = await dialog.confirm({
        title: `Update to v${entry.version}?`,
        body: 'Replaces design-system/ with the library release. Local edits to the current copy are lost.',
        confirmLabel: 'Update',
        tone: 'danger',
      })
      if (!confirmed || !workspaceRoot) return
      setPending('update')
      setMessage(null)
      try {
        const detached = await window.api.detachDesignSystemBundle(workspaceRoot)
        if (!detached.ok) {
          setMessage(detached.message)
          return
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error))
        return
      } finally {
        setPending(null)
      }
      await runAttach({ kind: 'library', id: entry.id }, 'update')
    },
    [dialog, runAttach, workspaceRoot],
  )

  if (!workspaceRoot) {
    return <p className="text-body leading-5 text-[color:var(--text-muted)]">Open a workspace first.</p>
  }
  if (bundle.kind === 'probing') return null

  const busy = pending !== null
  const update =
    bundle.kind === 'attached'
      ? findLibraryUpdate({ name: bundle.name, version: bundle.version }, libraryEntries)
      : null

  return (
    <div className="space-y-3">
      {bundle.kind === 'attached' ? (
        <>
          {/* The kit card, not a private box: this drew `rounded-md` over
              `--bg-raised` while every other settings surface draws
              `radius.shell` over `bg.surface-raised`. */}
          <SettingCard>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color:var(--bg-active)] font-mono text-micro text-[color:var(--text-muted)]"
              >
                DS
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-body font-medium text-[color:var(--text-strong)]">
                  {bundle.name}
                </div>
                <div className="truncate font-mono text-meta tabular-nums text-[color:var(--text-subtle)]">
                  v{bundle.version} · {bundle.componentCount} component
                  {bundle.componentCount === 1 ? '' : 's'} · {BUNDLE_ORIGIN_LABEL[bundle.origin]}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <OutlineButton size="xs" onClick={() => void onReplace()} disabled={busy}>
                  Replace
                </OutlineButton>
                <OutlineButton size="xs" onClick={() => void onDetach()} disabled={busy}>
                  {pending === 'detach' ? 'Detaching…' : 'Detach'}
                </OutlineButton>
              </div>
            </div>
            {/* The update line is a second row of the same card, not a box under
                it: it is a fact about the bundle above, and the card's hairline
                already separates them. */}
            {update?.version ? (
              <div className="flex items-center gap-3 px-3 py-2 text-meta text-[color:var(--text-muted)]">
                <span>
                  <span className="font-medium text-[color:var(--text-strong)]">v{update.version}</span> available
                </span>
                <OutlineButton size="xs" className="ml-auto" onClick={() => void onUpdate(update)} disabled={busy}>
                  {pending === 'update' ? 'Updating…' : 'Update'}
                </OutlineButton>
              </div>
            ) : null}
          </SettingCard>
        </>
      ) : null}

      {bundle.kind === 'broken' ? (
        <InlineNotice
          tone="warn"
          title="design-system/ exists but cannot be read as a bundle"
          detail={bundle.message}
          action={
            <OutlineButton size="xs" onClick={() => void onDetach()} disabled={busy}>
              {pending === 'detach' ? 'Detaching…' : 'Detach'}
            </OutlineButton>
          }
        />
      ) : null}

      {bundle.kind === 'none' && !pickerOpen ? (
        <div className="rounded-md border border-dashed border-[color:var(--border-default)] px-4 py-5 text-center">
          <p className="text-body leading-5 text-[color:var(--text-muted)]">No design system attached.</p>
          <PrimaryButton
            size="sm"
            className="mt-3"
            onClick={() => {
              setPickerSelection(null)
              setMessage(null)
              setPickerOpen(true)
            }}
          >
            Attach
          </PrimaryButton>
        </div>
      ) : null}

      {bundle.kind === 'none' && pickerOpen ? (
        <div className="space-y-3">
          <DesignSystemAttachStep
            workspaceRoot={workspaceRoot}
            selection={pickerSelection}
            onSelect={setPickerSelection}
            variant="settings"
          />
          <div className="flex items-center gap-2">
            <PrimaryButton
              size="sm"
              disabled={pickerSelection === null || busy}
              onClick={() => pickerSelection && void runAttach(pickerSelection, 'attach')}
            >
              {pending === 'attach' ? 'Attaching…' : 'Attach'}
            </PrimaryButton>
            <GhostButton size="sm" onClick={() => setPickerOpen(false)} disabled={busy}>
              Cancel
            </GhostButton>
          </div>
        </div>
      ) : null}

      {message ? <InlineNotice tone="error">{message}</InlineNotice> : null}
    </div>
  )
}
