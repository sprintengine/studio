import { GhostButton, PrimaryButton } from '../ui'
import { describeFound, importableCount } from './conversationImport'
import { ConversationImportPicker, useConversationImportSelection } from './ConversationImportPicker'
import type { ConversationImportScan } from './useConversationImportScan'

// The first-run offer of the conversations this person already had in Claude
// Code or Codex. The same plain centred card as the CLI question beside it,
// not a modal: the sidebar stays live, and "Not now" leaves the import in
// Settings → Agents for whenever they want it.
//
// Only shown once the scan has found something (onboardingState.ts), so the
// card always opens on a list.
export default function ConversationImportCard({
  scan,
  onDone,
}: {
  scan: Extract<ConversationImportScan, { status: 'ready' }>
  onDone: () => void
}) {
  const { selected, setSelected, importing, runImport } = useConversationImportSelection(scan.folders)
  const found = importableCount(scan.folders)
  return (
    <div className="pointer-events-none absolute inset-0 z-[var(--z-float)] grid place-items-center p-8">
      <div className="pointer-events-auto flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-[var(--radius-md)] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)]">
        <div className="px-5 pb-2 pt-4">
          <h2 className="text-title font-semibold text-[color:var(--text-strong)]">Bring your conversations</h2>
          <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {found === 1 ? 'Found 1 session' : `Found ${found} sessions`} you ran in the terminal (
            {describeFound(scan.folders)}
            ). Each one you pick becomes a chat with its history, and carries on the same session when you reply.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
          <ConversationImportPicker
            scan={scan}
            selected={selected}
            onSelectedChange={setSelected}
            disabled={importing}
          />
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">
          <GhostButton size="sm" disabled={importing} onClick={onDone}>
            Not now
          </GhostButton>
          <PrimaryButton
            size="sm"
            disabled={importing || selected.size === 0}
            onClick={() => {
              void runImport().then((imported) => {
                if (imported) onDone()
              })
            }}
          >
            {importing ? 'Importing…' : selected.size === 1 ? 'Import 1 session' : `Import ${selected.size} sessions`}
          </PrimaryButton>
        </div>
      </div>
    </div>
  )
}
