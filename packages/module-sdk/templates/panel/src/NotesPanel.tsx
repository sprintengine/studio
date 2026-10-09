import { useEffect, useInsertionEffect, useRef, useState, useSyncExternalStore } from 'react'

import type { RendererHost, WorkspacePanelProps } from '@sprintengine/module-sdk'
import { PanelHeader, Textarea } from '@sprintengine/module-sdk/ui'

import { ensureStyles } from './styles'

const NOTES_KEY = 'notes'
const SAVE_DELAY_MS = 400

// Module app state is the module's own key-value store in app settings:
// synchronous to read, so it can be read during render, and it survives a
// restart and a disable/enable. `storage` is the permission that discloses it.
// For per-workspace data use getWorkspaceModuleState; for anything large or
// written from entry.main, getModuleStorage.
export function createNotesPanel(host: RendererHost) {
  const subscribe = (onChange: () => void) => host.watchModuleAppState(() => onChange())
  const readSaved = () => host.getModuleAppState<string>(NOTES_KEY) ?? ''

  return function NotesPanel(_props: WorkspacePanelProps) {
    // Inserted before the panel paints, and never during a server render (the
    // smoke test's), which has no document to put a stylesheet in.
    useInsertionEffect(ensureStyles, [])
    // The third argument is what a server render reads: without it, rendering
    // the panel anywhere but a window throws.
    const saved = useSyncExternalStore(subscribe, readSaved, readSaved)
    const [draft, setDraft] = useState(saved)
    const lastSaved = useRef(saved)

    // Another window saved: take its text, unless this one has unsaved edits.
    useEffect(() => {
      setDraft((current) => (current === lastSaved.current ? saved : current))
      lastSaved.current = saved
    }, [saved])

    useEffect(() => {
      if (draft === saved) return
      const timer = window.setTimeout(() => host.setModuleAppState(NOTES_KEY, draft), SAVE_DELAY_MS)
      return () => window.clearTimeout(timer)
    }, [draft, saved])

    return (
      <div className="{{id}}-panel">
        <PanelHeader title="Notes" subtitle={draft === saved ? 'Saved' : 'Saving…'} />
        <Textarea
          aria-label="Notes"
          className="{{id}}-panel__text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write anything. It is kept across restarts."
          resize="none"
          fullWidth
        />
      </div>
    )
  }
}
