import React, { Suspense, lazy, useEffect, useState } from 'react'
import type { AuxWindowKind } from '../../../../shared/electron-api'
import { writeAuxWindowBounds } from './auxWindowPlacement'

// Monaco is heavy and must stay out of the eager boot chunk (enforced by
// scripts/check-bundle-budget.mjs), so the diff viewer loads behind React.lazy
// just like EditorPanel does in the workspace shell.
const DiffViewerWindow = lazy(() => import('./DiffViewerWindow'))

function AuxLoading() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] text-[13px] text-[color:var(--text-disabled)]">
      Loading…
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
  const [descriptor] = useState(readInitialParams)
  const [params, setParams] = useState<AuxWindowParams>(descriptor?.params ?? {})

  useEffect(() => {
    if (!descriptor) return
    return window.api.onAuxWindowRetarget((payload) => {
      if (payload.kind === descriptor.kind) setParams(payload.params)
    })
  }, [descriptor])

  useEffect(() => {
    if (!descriptor) return
    return window.api.onWindowPlacementChanged((placement) => {
      writeAuxWindowBounds(descriptor.kind, placement.bounds)
    })
  }, [descriptor])

  if (!descriptor) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] text-[13px] text-[color:var(--tone-error)]">
        Unknown auxiliary window.
      </div>
    )
  }

  if (descriptor.kind === 'diff') {
    const focusKind = params.scope === 'staged' ? 'staged' : params.scope === 'unstaged' ? 'unstaged' : null
    if (!params.repoRoot) {
      return (
        <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] text-[13px] text-[color:var(--tone-error)]">
          Missing repository for diff viewer.
        </div>
      )
    }
    return (
      <Suspense fallback={<AuxLoading />}>
        <DiffViewerWindow
          // Remount on each distinct target so a retarget (new file / scope, or a
          // different repo) lands its focus cleanly; an identical request reuses
          // the instance and the main process just re-focuses the OS window.
          key={`${params.repoRoot}::${params.focusPath ?? ''}::${params.scope ?? ''}`}
          repoRoot={params.repoRoot}
          focusPath={params.focusPath ?? null}
          focusKind={focusKind}
        />
      </Suspense>
    )
  }

  // `file` kind (external editor) is wired in a later slice.
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-[color:var(--bg-app)] text-[13px] text-[color:var(--text-disabled)]">
      External file editor coming soon.
    </div>
  )
}
