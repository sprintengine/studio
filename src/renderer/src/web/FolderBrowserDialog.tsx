import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

import type { FolderBrowserListing } from '../../../shared/web-client'
import { Checkbox } from '../components/ui/Checkbox'
import { FolderGlyph } from '../components/ui/FileTypeGlyph'
import { InlineNotice } from '../components/ui/InlineNotice'
import { Input } from '../components/ui/Input'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../components/ui/Modal'
import { RowButton } from '../components/ui/RowButton'

// The folder picker a web tab shows where a desktop window opens the OS's own
// (phase 9 spec, 4.1 #7, 6.5). The folders are the server's, listed by the
// server: a browser has no paths of that machine to offer. Directories only,
// a typed path, an Up row, and hidden folders on request.

type Browse = (input: { path?: string; showHidden?: boolean }) => Promise<FolderBrowserListing>

export function FolderBrowserDialog({
  browse,
  defaultPath,
  onDone,
}: {
  browse: Browse
  defaultPath?: string
  onDone: (path: string | null) => void
}): React.JSX.Element {
  const titleId = useId()
  const [listing, setListing] = useState<Extract<FolderBrowserListing, { ok: true }> | null>(null)
  const [typed, setTyped] = useState(defaultPath ?? '')
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)

  const open = useCallback(
    async (path: string | undefined, hidden: boolean) => {
      const ticket = ++asked.current
      setLoading(true)
      try {
        const next = await browse({ ...(path ? { path } : {}), showHidden: hidden })
        if (ticket !== asked.current) return
        if (next.ok) {
          setListing(next)
          setTyped(next.path)
          setError(null)
        } else setError(next.message)
      } catch (failure) {
        if (ticket === asked.current) setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        if (ticket === asked.current) setLoading(false)
      }
    },
    [browse],
  )

  useEffect(() => {
    void open(defaultPath, false)
  }, [open, defaultPath])

  return (
    <Modal open onClose={() => onDone(null)} labelledBy={titleId} size="standard" layout="panel">
      <ModalHeader
        titleId={titleId}
        title="Choose a folder"
        subtitle="Folders on the machine Studio runs on."
        onClose={() => onDone(null)}
      />
      <ModalBody className="flex min-h-0 flex-1 flex-col gap-3">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void open(typed, showHidden)
          }}
        >
          <Input
            aria-label="Folder path"
            value={typed}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
          />
        </form>
        {error ? <InlineNotice tone="error" title={error} /> : null}
        <div role="list" aria-label="Folders" aria-busy={loading} className="min-h-0 flex-1 overflow-y-auto">
          {listing?.parent ? (
            <div role="listitem">
              <RowButton onClick={() => void open(listing.parent ?? undefined, showHidden)}>
                <FolderGlyph />
                <span>..</span>
              </RowButton>
            </div>
          ) : null}
          {listing?.entries.map((entry) => (
            <div role="listitem" key={entry.path}>
              <RowButton onClick={() => void open(entry.path, showHidden)}>
                <FolderGlyph />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.project ? (
                  <span className="text-meta text-[color:var(--text-muted)]">Git repository</span>
                ) : entry.hint === 'not-a-project' ? (
                  <span className="text-meta text-[color:var(--text-subtle)]">Probably not a project</span>
                ) : null}
              </RowButton>
            </div>
          ))}
          {listing && listing.entries.length === 0 ? (
            <p className="px-2 py-3 text-meta text-[color:var(--text-muted)]">No folders here.</p>
          ) : null}
          {listing?.truncated ? (
            <p className="px-2 py-3 text-meta text-[color:var(--text-muted)]">
              Only the first thousand folders are listed. Type a path to go further.
            </p>
          ) : null}
        </div>
        <Checkbox
          checked={showHidden}
          label="Show hidden folders"
          onChange={(next) => {
            setShowHidden(next)
            void open(listing?.path, next)
          }}
        />
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={() => onDone(null)}>Cancel</ModalButton>
        <ModalButton variant="primary" disabled={!listing} onClick={() => listing && onDone(listing.path)}>
          Choose this folder
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

/** Show the dialog over the app and settle with the chosen folder, or null when it was dismissed. */
export function pickServerFolder(browse: Browse, defaultPath?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const done = (path: string | null) => {
      root.unmount()
      host.remove()
      resolve(path)
    }
    root.render(<FolderBrowserDialog browse={browse} defaultPath={defaultPath} onDone={done} />)
  })
}
