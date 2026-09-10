import type { RegisteredModalSurfaceLauncher, SurfaceIconComponent } from '../../../modules/renderer-host'
import type { WorkspacePaneTabKind } from '../../../types/workspace'

// The kinds the workspace pane can open, in the order the "+" menu and the
// empty-state launcher list them. A kind whose module is disabled is absent
// from both, not present-but-empty.
//
// Most kinds become a TAB of the pane. A kind with `modalSurfaceId` does not:
// picking it floats that registered modal surface over the page at workbench
// width instead (Reviews, 2026-09-05). The pane is still where the person
// reaches for it — it sits in the same list as Browser and Diff, because it is
// the same kind of thing, a view of this workspace's work — but the pane
// column is too narrow to read a walkthrough in, so the pane hands it off.
//
// Those modal rows are CONTRIBUTED, not listed here (D7, 2026-09-10): a module
// declares one on its modal surface (`registerModalSurface({ launcher })`) and
// `composePaneKinds` appends it to the static list below. Reviews was the one
// hard-coded row, and it left with the review module.

// What the launcher and the "+" menu can pick: every tab kind, plus the ids of
// contributed modal rows — open strings, because the shell cannot know them.
// The `(string & {})` arm keeps editor completion on the tab kinds.
export type PaneLaunchKind = WorkspacePaneTabKind | (string & {})

export type PaneKindDefinition = {
  kind: PaneLaunchKind
  label: string
  // The letter that opens the kind while the "+" menu or the launcher has
  // focus. Uppercase, as the hint column prints it.
  letter: string
  // Capability module the kind belongs to; undefined for core kinds.
  moduleId?: string
  // The same component type a module hands the host, so a contributed row's
  // glyph and a built-in one are the same kind of thing here.
  Glyph: SurfaceIconComponent
  // Set when picking the kind opens a modal surface rather than a pane tab.
  modalSurfaceId?: string
}

function TerminalGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 6.5 7 8.5 5 10.5M8.5 10.5h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FilesGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function GitGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function DiffGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M5 2.5v5M2.5 5h5M2.5 11.5h5M8.5 13.5l4-11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function BrowserGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// The header's Backlog switch draws this same mark (PanelSwitches): one glyph
// for the surface on both ends of the gesture.
function BacklogGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M6 4.5h7M6 8h7M6 11.5h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="3" cy="4.5" r="1" fill="currentColor" />
      <circle cx="3" cy="8" r="1" fill="currentColor" />
      <circle cx="3" cy="11.5" r="1" fill="currentColor" />
    </svg>
  )
}

// The five general-purpose kinds first, in the order below; Backlog is
// ours alone and goes last so the shared five keep the low chord numbers.
// Its letter is L (back-L-og) because B is Browser's.
export const STATIC_PANE_KINDS: readonly PaneKindDefinition[] = [
  { kind: 'browser', label: 'Browser', letter: 'B', Glyph: BrowserGlyph },
  { kind: 'terminal', label: 'Terminal', letter: 'T', Glyph: TerminalGlyph },
  { kind: 'files', label: 'Files', letter: 'F', moduleId: 'dev-tools', Glyph: FilesGlyph },
  { kind: 'diff', label: 'Diff', letter: 'D', moduleId: 'git', Glyph: DiffGlyph },
  { kind: 'git', label: 'Git', letter: 'G', moduleId: 'git', Glyph: GitGlyph },
  { kind: 'backlog', label: 'Backlog', letter: 'L', moduleId: 'backlog', Glyph: BacklogGlyph },
]

// The list one pane offers: the shell's own kinds, then the rows modules
// contributed, each dropped when its module is off (absent, never greyed).
//
// Static rows win a letter collision. The shell's keys are muscle memory and
// the person did not install anything to lose them, so a contributed row that
// wants a taken letter — or one an earlier contributed row already took —
// keeps its label and glyph and simply has no shortcut; the launchers print
// nothing in the hint column and no keypress opens it. Two modules cannot be
// made to agree on letters, so the arbitration has to live here.
export function composePaneKinds(
  launchers: readonly RegisteredModalSurfaceLauncher[],
  moduleEnabled: (moduleId: string) => boolean,
): PaneKindDefinition[] {
  const kinds = STATIC_PANE_KINDS.filter(
    (definition) => !definition.moduleId || moduleEnabled(definition.moduleId),
  )
  const taken = new Set(kinds.map((definition) => definition.letter))
  for (const launcher of launchers) {
    if (!moduleEnabled(launcher.moduleId)) continue
    const free = launcher.letter.length > 0 && !taken.has(launcher.letter)
    if (free) taken.add(launcher.letter)
    kinds.push({
      kind: launcher.surfaceId,
      label: launcher.label,
      letter: free ? launcher.letter : '',
      moduleId: launcher.moduleId,
      Glyph: launcher.Glyph,
      modalSurfaceId: launcher.surfaceId,
    })
  }
  return kinds
}

// A tab's own row. Only ever asked about TAB kinds (a contributed row opens a
// modal and never becomes a tab), so the static list is the whole answer.
export function paneKindDefinition(kind: PaneLaunchKind): PaneKindDefinition {
  return (
    STATIC_PANE_KINDS.find((definition) => definition.kind === kind)
    ?? { kind, label: kind, letter: kind[0]?.toUpperCase() ?? '', Glyph: BrowserGlyph }
  )
}

// Kinds that keep their panel mounted while another tab is showing: a
// terminal's buffer (and, later, a browser's page) must survive a tab switch.
export function paneKindRetainsPanel(kind: WorkspacePaneTabKind): boolean {
  return kind === 'terminal' || kind === 'browser'
}
