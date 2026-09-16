import type { RunDoorId } from './runDoors'

// What each door is called and what it says (item 2470, mockup Frame 1).
//
// Two doors, one surface. Everything that differs between Workflows and Sprints
// is a string, and every one of those strings lives here — the surface, the rail
// and the inline new-row all read this table, so the two doors cannot drift into
// two dialects the way three copy-pasted door surfaces once did.
//
// The doors explain themselves by what they offer, not by a line of prose over
// the rail: no tagline under the door's name, no reminder on the new-row, no
// badge on a run. The one place a door still says what it is for in words is
// its first-run canvas, where there is nothing else to read.
//
// Naming stays honest about what already exists on disk. A run's state, its MCP
// tools and its saved rosters keep their spelling; this is a change in what a
// person is offered, not a rename of the engine.

export type RunDoorDefinition = {
  id: RunDoorId
  /** The door's name — the rail's section label and the surface bar's title. */
  label: string
  /** What one of this door's runs is called, in lower case. */
  noun: string
  /** The same, in the plural. */
  nounPlural: string
  /** The rail's "New …" affordance, which opens the New sprint dialog. */
  newLabel: string
  search: { placeholder: string; ariaLabel: string }
  filterAriaLabel: string
  scopeAriaLabel: string
  /** Why a narrowed rail is empty — searched, and scoped to a quiet project. */
  emptyRail: { searched: string; scoped: string }
  /** The canvas when the door has never held a run of its kind. */
  firstRun: { title: string; body: string }
  /** The canvas when runs exist but the lens hides them all. */
  filteredOutTitle: string
  /** The canvas when runs exist and none is selected. */
  selectPromptTitle: string
  /** The canvas's first read. */
  loadingLabel: string
  /** Why the canvas failed to read the run index — per door, never a shared "sprints" string. */
  indexError: { title: string; hint: string }
}

export const WORKFLOWS_DOOR: RunDoorDefinition = {
  id: 'workflows',
  label: 'Workflows',
  noun: 'workflow',
  nounPlural: 'workflows',
  newLabel: 'New workflow',
  search: {
    placeholder: 'Search workflows…',
    ariaLabel: 'Search workflows across every project',
  },
  filterAriaLabel: 'Filter and sort workflows',
  scopeAriaLabel: 'Filter by project',
  emptyRail: { searched: 'No workflows match.', scoped: 'No workflows in this project.' },
  firstRun: {
    title: 'Run your first workflow',
    body: 'Say what you want done and pick who does it. The architect reads your project, works out the tasks, and the roster works them. Runs from every project list here.',
  },
  filteredOutTitle: 'No workflows match. Clear the search or pick All projects to see the rest.',
  selectPromptTitle: 'Select a workflow to see where it stands.',
  loadingLabel: 'Loading your workflows…',
  indexError: {
    title: 'Couldn’t load your workflows.',
    hint: 'Your runs are still on disk — this is usually temporary.',
  },
}

export const SPRINTS_DOOR: RunDoorDefinition = {
  id: 'sprints',
  label: 'Sprints',
  noun: 'sprint',
  nounPlural: 'sprints',
  newLabel: 'New sprint',
  search: {
    placeholder: 'Search sprints…',
    ariaLabel: 'Search sprints across every project',
  },
  filterAriaLabel: 'Filter and sort sprints',
  scopeAriaLabel: 'Filter by project',
  emptyRail: { searched: 'No sprints match.', scoped: 'No sprints in this project.' },
  firstRun: {
    title: 'Run your first sprint',
    body: 'A sprint takes work you have already written down and puts agents on it, one task each, until the graph is empty. Runs from every project list here.',
  },
  filteredOutTitle: 'No sprints match. Clear the search or pick All projects to see the rest.',
  selectPromptTitle: 'Select a sprint to see where it stands.',
  loadingLabel: 'Loading your sprints…',
  indexError: {
    title: 'Couldn’t load your sprints.',
    hint: 'Your runs are still on disk — this is usually temporary.',
  },
}
