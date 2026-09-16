import { useState } from 'react'

import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import { Field, Input, Select, Textarea, type SelectItem } from '../ui'
import type { BacklogCriticality, BacklogDifficulty } from '../../utils/backlog'

// The structured capture dialog for a new backlog item. A backlog item is
// lightweight intent — a title plus the what/why — and its triage (size,
// priority) is set here rather than authored as markdown frontmatter. The
// implementation is deliberately left to whoever picks the item up,
// so the description hint steers away from implementation components.
export type BacklogDraft = {
  title: string
  description: string
  difficulty: BacklogDifficulty | 'unset'
  criticality: BacklogCriticality | 'unset'
}

export function BacklogCreateDialog({
  difficultyItems,
  criticalityItems,
  onClose,
  onCreate,
}: {
  difficultyItems: SelectItem<BacklogDifficulty | 'unset'>[]
  criticalityItems: SelectItem<BacklogCriticality | 'unset'>[]
  onClose: () => void
  // Resolves once the item is created (the parent closes the dialog); rejects
  // with the failure so it can be shown in-context without losing the draft.
  onCreate: (draft: BacklogDraft) => Promise<void>
}): JSX.Element {
  const [draft, setDraft] = useState<BacklogDraft>({
    title: '',
    description: '',
    difficulty: 'unset',
    criticality: 'unset',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = 'backlog-create-title'
  const canSubmit = draft.title.trim().length > 0 && !busy

  const submit = (): void => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    void onCreate(draft).catch((cause) => {
      // The parent closes this dialog on success; on failure it stays open with
      // the draft intact and the reason shown here, rather than behind the modal.
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    })
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} labelledBy={titleId} size="standard">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <ModalHeader title="New backlog item" titleId={titleId} onClose={busy ? undefined : onClose} />
        <ModalBody className="space-y-3">
          <Field label="Title" htmlFor="backlog-create-item-title">
            <Input
              value={draft.title}
              autoFocus
              placeholder="e.g. Realtime presence indicators"
              onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
              size="md"
            />
          </Field>
          <Field
            label="Description"
            htmlFor="backlog-create-item-description"
            help="Capture the intent — the what and why. Leave implementation to the plan."
          >
            <Textarea
              value={draft.description}
              rows={4}
              placeholder="What outcome does this enable, or what is broken?"
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              size="md"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Size" htmlFor="backlog-create-item-size">
              <Select
                ariaLabel="Item size"
                items={difficultyItems}
                value={draft.difficulty}
                onChange={(value) => setDraft((current) => ({ ...current, difficulty: value }))}
              />
            </Field>
            <Field label="Priority" htmlFor="backlog-create-item-priority">
              <Select
                ariaLabel="Item priority"
                items={criticalityItems}
                value={draft.criticality}
                onChange={(value) => setDraft((current) => ({ ...current, criticality: value }))}
              />
            </Field>
          </div>
          {error ? (
            <p role="alert" className="text-meta leading-5 text-[color:var(--tone-error)]">
              Couldn’t create the item: {error}
            </p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={onClose} disabled={busy}>
            Cancel
          </ModalButton>
          <ModalButton type="submit" variant="primary" disabled={!canSubmit}>
            {busy ? 'Creating…' : 'Create item'}
          </ModalButton>
        </ModalFooter>
      </form>
    </Modal>
  )
}
