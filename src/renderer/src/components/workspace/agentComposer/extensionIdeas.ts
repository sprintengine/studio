// The ideas the New chat door offers in extension mode, one for each surface
// an extension can add (the SDK's templates, packages/module-sdk/templates), so
// the cards together show what the SDK reaches.
//
// A card starts nothing. Choosing one puts its `prompt` in the box as it is,
// for the person to change before they send it: the words are theirs from
// then on, so each one reads as a person would put it, first person, with the
// surface named.

export type ExtensionIdea = {
  id: string
  /** What the idea adds to Studio, in the words the SDK's surface table uses. */
  surface: string
  title: string
  /** One line under the title. */
  description: string
  /** What goes in the box. */
  prompt: string
}

export const EXTENSION_IDEAS: readonly ExtensionIdea[] = [
  {
    id: 'top-bar-item',
    surface: 'Top bar',
    title: 'PR review badge',
    description: 'A count of the PRs waiting on you, in the top bar.',
    prompt:
      'A top-bar badge counting the pull requests waiting on my review; clicking it lists them and opens one in the browser.',
  },
  {
    id: 'mcp-tools',
    surface: 'MCP tools',
    title: 'Tools for my issue tracker',
    description: 'Let any agent search and update your tracker.',
    prompt: "MCP tools any agent can call to search my team's issue tracker and add a comment to an issue.",
  },
  {
    id: 'global-surface',
    surface: 'Page + sidebar row',
    title: 'Release dashboard',
    description: 'A full page listing open PRs and CI status across projects.',
    prompt:
      'A full page with its own sidebar row that shows open pull requests and CI status for every project I have open.',
  },
  {
    id: 'backlog-action',
    surface: 'Backlog action',
    title: 'Break it down',
    description: 'A Backlog item action that splits an item into smaller ones.',
    prompt:
      'A Backlog item action that starts a chat to split the item into smaller items, each one a day of work or less.',
  },
  {
    id: 'panel',
    surface: 'Panel',
    title: 'Project scratchpad',
    description: 'A notes panel per project that stays between sessions.',
    prompt:
      'A scratchpad panel for each project that keeps my notes between sessions and lets me paste a note into a chat.',
  },
  {
    id: 'file-action',
    surface: 'Files action',
    title: 'Explain this file',
    description: 'Right-click a file to open a chat that walks through it.',
    prompt:
      'A Files action that opens a chat explaining the selected file: what it does, who calls it and what to watch out for.',
  },
  {
    id: 'chat-companion',
    surface: 'Chats',
    title: 'Second-opinion reviewer',
    description: 'Starts a chat that reviews what another chat changed.',
    prompt: 'When a chat finishes, start a second chat that reviews the changes it made and reports anything risky.',
  },
  {
    id: 'settings-section',
    surface: 'Settings',
    title: 'Commit conventions',
    description: 'A Settings section for your commit-message rules.',
    prompt:
      'A Settings section where I set our commit-message rules, and a command that checks the staged message against them.',
  },
  {
    id: 'workspace-type',
    surface: 'Workspace type',
    title: 'Standup workspace',
    description: "Opens on yesterday's commits and today's Backlog.",
    prompt:
      "A standup workspace type that opens with yesterday's commits across my projects and today's Backlog items.",
  },
  {
    id: 'blank',
    surface: 'Command',
    title: 'Copy branch link',
    description: 'A palette command that copies the branch URL.',
    prompt: 'A command in the palette that copies a link to the current branch on GitHub.',
  },
]

/** How many show before "Show all": four, each a different surface. */
export const EXTENSION_IDEAS_FIRST = 4
