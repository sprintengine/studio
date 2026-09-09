import React, { Suspense, lazy, useEffect, useState } from 'react'
import type { AuxWindowKind } from '../../../../shared/electron-api'
import { useAppTheme } from '../../hooks/useAppTheme'
import { writeAuxWindowBounds } from './auxWindowPlacement'
import { InlineNotice, Spinner } from '../ui'

// Monaco is heavy and must stay out of the eager boot chunk (enforced by
// scripts/check-bundle-budget.mjs), so the diff viewer loads behind React.lazy
// just like EditorPanel does in the workspace shell.
const DiffViewerWindow = lazy(() => import('./DiffViewerWindow'))
const ExternalEditorWindow = lazy(() => import('./ExternalEditorWindow'))

function AuxLoading() {
  return (
    <div className="flex h-screen w-screen items-center justify-center gap-2 bg-[color:var(--bg-app)] text-body text-[color:var(--text-muted)]">
      <Spinner />
      Loading…
    </div>
  )
}

// A window that cannot open at all: the kit's notice, centred in the empty
// window, rather than a red sentence floating in the middle of it (MC-2115).
function AuxFailure({ message }: { message: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] px-6">
      <InlineNotice tone="error" className="max-w-md">
        {message}
      </InlineNotice>
    </div>
  )
}

// Root for lightweight auxiliary windows. Mounted by `main.tsx` when the renderer
// is loaded with `?aux=<kind>` — a sibling of the diagnostics window root, not
// the workspace shell. It reads the initial params from the URL, updates them on
// `aux:retarget` (singleton windows are reused, not reopened), and persists its
// bounds per kind so the next open reuses the size/position.

export type AuxWindowParams = Record<string, string>

function readInitialParams(): { kind: AuxWindowKind; params: AuxWindowParams } | null {
  const search = new URLSearchParams(window.location.search)
  const kind = search.get('aux')
  if (kind !== 'diff' && kind !== 'file') return null
  const params: AuxWindowParams = {}
  search.forEach((value, key) => {
    if (key !== 'aux') params[key] = value
  })
  return { kind, params }
}

export default function AuxWindowApp() {
  // Drive <html data-theme="…"> from the persisted preference, exactly like the
  // workspace shell. The boot script in index.html applies the initial theme to
  // avoid a flash; this keeps the attribute (and the CSS variables the chrome
  // reads) correct for the window's lifetime instead of leaving it frozen.
  useAppTheme()
  const [descriptor] = useState(readInitialParams)
  const [params, setParams] = useState<AuxWindowParams>(descriptor?.params ?? {})
  // Bumps on every retarget (even a repeat of the same params) so the file
  // window can re-focus/append a tab without the params object having changed.
  const [retargetNonce, setRetargetNonce] = useState(0)

  useEffect(() => {
    if (!descriptor) return
    return window.api.onAuxWindowRetarget((payload) => {
      if (payload.kind !== descriptor.kind) return
      setParams(payload.params)
      setRetargetNonce((n) => n + 1)
    })
  }, [descriptor])

  useEffect(() => {
    if (!descriptor) return
    return window.api.onWindowPlacementChanged((placement) => {
      writeAuxWindowBounds(descriptor.kind, placement.bounds)
    })
  }, [descriptor])

  if (!descriptor) {
    return <AuxFailure message="Unknown auxiliary window." />
  }

  if (descriptor.kind === 'diff') {
    const focusKind = params.scope === 'staged' ? 'staged' : params.scope === 'unstaged' ? 'unstaged' : null
    if (!params.repoRoot) {
      return <AuxFailure message="Missing repository for diff viewer." />
    }
    return (
      <Suspense fallback={<AuxLoading />}>
        <DiffViewerWindow
          // Keyed on the REPOSITORY and the CHANGELIST. A retarget to another
          // file in the same repo flows in as props and the viewer walks its
          // own cursor there; keying on the file remounted Monaco under the
          // diff widget on every Git row click — the flash the pane tab was
          // careful to avoid (see WorkspacePaneBody). A different repository is
          // a different file list, and that does start over.
          //
          // A different CHANGELIST is a different file list too, and it starts
          // over for the same reason: the viewer holds a cursor, a chosen
          // filter and a hunk read that are all about the list it opened on, so
          // retargeting one into another leaves a cursor pointing at a file the
          // new list may not contain. The empty string is "no filter", which is
          // the key every diff opened before agent changelists carries.
          key={`${params.repoRoot}\n${params.changelistId ?? ''}`}
          repoRoot={params.repoRoot}
          focusPath={params.focusPath ?? null}
          focusKind={focusKind}
          changelistId={params.changelistId ?? null}
          workspaceId={params.workspaceId ?? null}
        />
      </Suspense>
    )
  }

  // External editor window: a singleton tabbed Monaco host. It is NOT remounted
  // per file (that would drop the other open tabs) — the incoming file + nonce
  // drive tab add/focus inside the component.
  const incoming = params.filePath
    ? { filePath: params.filePath, fileName: params.fileName ?? params.filePath, workspaceId: params.workspaceId ?? '' }
    : null
  return (
    <Suspense fallback={<AuxLoading />}>
      <ExternalEditorWindow incoming={incoming} nonce={retargetNonce} />
    </Suspense>
  )
}
