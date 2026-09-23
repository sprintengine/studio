import React, { useEffect, useId, useState } from 'react'

import { DescribedCheckRow, DescribedCheckRowList, InlineNotice } from '../../../ui'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../../ui/Modal'
import { CANVAS_EXPORT_DEFAULT_FORMATS, canvasExportFileNames, type CanvasExportFormats } from './canvasExport'

// The Export dialog: which files an export writes, before the folder picker
// asks where.
//
// The board file is always one of them — it is the thing that goes into the
// repository, and an export without it would be a screenshot. The two pictures
// are optional rows beneath it, off by default, because a PNG committed beside
// every diagram is a binary nobody asked the repository to carry.
//
// The folder is not chosen here. Main shows the system's own folder picker once
// the person presses Export, so the place the files land is one they pointed
// at in the file manager rather than a path this surface typed.

type CanvasExportDialogProps = {
  open: boolean
  /** The board's display name; the files are named after it. */
  boardName: string
  /** An export in flight: the rows and buttons hold still until it answers. */
  pending: boolean
  /** Why the last attempt failed, said above the buttons; null when it did not. */
  error: string | null
  onCancel: () => void
  onExport: (formats: CanvasExportFormats) => void
}

export function CanvasExportDialog({ open, boardName, pending, error, onCancel, onExport }: CanvasExportDialogProps) {
  const titleId = useId()
  const rowId = useId()
  const [formats, setFormats] = useState<CanvasExportFormats>(CANVAS_EXPORT_DEFAULT_FORMATS)

  // Each opening starts from the default: the pictures are a per-export choice,
  // and a PNG ticked for one board should not ride along with the next.
  useEffect(() => {
    if (open) setFormats(CANVAS_EXPORT_DEFAULT_FORMATS)
  }, [open])

  const files = canvasExportFileNames(boardName, formats)

  return (
    <Modal open={open} onClose={pending ? () => {} : onCancel} labelledBy={titleId} size="standard">
      <ModalHeader
        title={`Export ${boardName}`}
        titleId={titleId}
        subtitle="Write a copy of this board into a folder you choose — the way to add it to the repository. The board itself stays where the app keeps it."
        onClose={pending ? undefined : onCancel}
      />
      <ModalBody className="flex flex-col gap-3">
        <DescribedCheckRowList ariaLabel="Files to export">
          <DescribedCheckRow
            id={`${rowId}-board`}
            title="Board file"
            code={files[0]}
            description="The editable board, readable by the Canvas and by any editor for the format."
            checked
            disabled
            onChange={() => {}}
          />
          <DescribedCheckRow
            id={`${rowId}-png`}
            title="PNG image"
            code={`${boardName}.png`}
            description="A picture of the board, for a README or a pull request."
            checked={formats.png}
            disabled={pending}
            onChange={(png) => setFormats((current) => ({ ...current, png }))}
          />
          <DescribedCheckRow
            id={`${rowId}-svg`}
            title="SVG image"
            code={`${boardName}.svg`}
            description="The same picture as a vector, sharp at any size."
            checked={formats.svg}
            disabled={pending}
            onChange={(svg) => setFormats((current) => ({ ...current, svg }))}
          />
        </DescribedCheckRowList>
        {/* The recovery is the Export button below it: the dialog stays open on
            the choice the person made, so trying again is one press. */}
        {error ? <InlineNotice tone="error" title="The board was not exported" hint={error} /> : null}
      </ModalBody>
      <ModalFooter>
        <ModalButton type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </ModalButton>
        <ModalButton type="button" variant="primary" onClick={() => onExport(formats)} disabled={pending} autoFocus>
          {pending ? 'Exporting…' : 'Choose folder and export'}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}
