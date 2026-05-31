import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Field, GhostButton, PrimaryButton } from '../../ui'

const DEFAULT_NEW_FOLDER_NAME = 'new-workspace'

function suggestedWorkspaceFolderName(workspaceName: string): string {
  const slug = workspaceName
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug || DEFAULT_NEW_FOLDER_NAME
}

function validateWorkspaceFolderName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\]/.test(trimmed)) {
    return 'Enter a valid folder name.'
  }
  if (/[\u0000-\u001f<>:"|?*]/u.test(trimmed)) {
    return 'Folder names cannot contain control characters or <>:"|?*.'
  }
  if (/[. ]$/u.test(trimmed)) {
    return 'Folder names cannot end with a period or space.'
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(trimmed)) {
    return 'That folder name is reserved by Windows.'
  }
  return null
}

/**
 * Inline create-folder affordance for the workspace step. Owns its own draft
 * state (parent, name, error, pending) so keystrokes don't re-render the whole
 * New Workspace panel, and uses no overlay — the previous modal's contained
 * backdrop-blur was repainting the entire panel on every hover frame.
 */
export function CreateFolderField({
  defaultParentPath,
  workspaceName,
  onCreated,
}: {
  defaultParentPath: string | null
  workspaceName: string
  onCreated: (createdPath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  const nameInputId = 'create-folder-name'

  const collapse = useCallback(() => {
    setExpanded(false)
    setParentPath(null)
    setName('')
    setError(null)
  }, [])

  const open = () => {
    setParentPath(defaultParentPath)
    setName(suggestedWorkspaceFolderName(workspaceName))
    setError(null)
    setExpanded(true)
  }

  useEffect(() => {
    if (!expanded) return
    const id = window.setTimeout(() => {
      nameInputRef.current?.focus()
      nameInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(id)
  }, [expanded])

  const pickParent = async () => {
    const parentDir = await window.api.openDir()
    if (!parentDir) return
    setParentPath(parentDir)
    setError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (isCreating) return
    if (!parentPath) {
      setError('Choose a parent folder.')
      return
    }
    const validationError = validateWorkspaceFolderName(name)
    if (validationError) {
      setError(validationError)
      return
    }

    setIsCreating(true)
    setError(null)
    try {
      if (typeof window.api.createWorkspaceFolder !== 'function') {
        throw new Error('Restart Multicode to finish enabling folder creation.')
      }
      const createdPath = await window.api.createWorkspaceFolder(parentPath, name.trim())
      collapse()
      onCreated(createdPath)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not create that folder.'
      setError(message)
    } finally {
      setIsCreating(false)
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={open}
        aria-expanded={false}
        className="
          group flex w-full min-w-0 items-center gap-3 rounded px-2 py-1.5 text-left
          transition-colors hover:bg-[color:var(--bg-surface-raised)]
          focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent-primary)]
        "
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-[color:var(--bg-surface-raised)] text-[color:var(--text-subtle)] group-hover:text-[color:var(--text-muted)]"
        >
          <svg className="icon-md" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M3.75 7.5C3.75 6.39543 4.64543 5.5 5.75 5.5H9.5L11.5 7.5H18.25C19.3546 7.5 20.25 8.39543 20.25 9.5V16.25C20.25 17.3546 19.3546 18.25 18.25 18.25H5.75C4.64543 18.25 3.75 17.3546 3.75 16.25V7.5Z"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
            <path d="M12 10.25V15.25M9.5 12.75H14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </span>
        <span className="block truncate text-[13px] font-medium text-[color:var(--text-default)]">
          Create new folder
        </span>
      </button>
    )
  }

  const trimmedName = name.trim()

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        // Collapse the inline editor on Escape, and stop the event reaching the
        // panel-level Escape handler that would otherwise close the whole wizard.
        if (event.key === 'Escape' && !isCreating) {
          event.preventDefault()
          event.stopPropagation()
          event.nativeEvent.stopImmediatePropagation()
          collapse()
        }
      }}
      className="flex flex-col gap-3 px-2 pb-1 pt-2"
    >
      <div className="flex flex-col gap-1.5">
        <Field.Label>Parent folder</Field.Label>
        <div className="flex items-center gap-2">
          <div
            className={`min-w-0 flex-1 truncate rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2 font-mono text-[12px] ${
              parentPath ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-disabled)]'
            }`}
          >
            {parentPath ?? 'Choose a parent folder'}
          </div>
          <GhostButton size="md" onClick={() => void pickParent()} disabled={isCreating}>
            Browse
          </GhostButton>
        </div>
      </div>

      <Field label="Folder name" htmlFor={nameInputId} error={error ?? undefined}>
        <input
          ref={nameInputRef}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          className="
            h-10 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3
            text-[13px] text-[color:var(--text-strong)] outline-none transition-colors
            placeholder:text-[color:var(--text-disabled)]
            hover:border-[color:var(--border-strong)] focus:border-[color:var(--text-strong)]
          "
          placeholder={DEFAULT_NEW_FOLDER_NAME}
          disabled={isCreating}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <div className="flex items-center justify-end gap-2">
        <GhostButton size="md" onClick={collapse} disabled={isCreating}>
          Cancel
        </GhostButton>
        <PrimaryButton size="md" type="submit" disabled={isCreating || trimmedName.length === 0}>
          {isCreating ? 'Creating…' : 'Create folder'}
        </PrimaryButton>
      </div>
    </form>
  )
}
