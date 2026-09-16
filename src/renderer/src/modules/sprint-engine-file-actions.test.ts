import assert from 'node:assert/strict'

import {
  isSingleMarkdownPlanSelection,
  isSourceBundleOutsideBacklog,
  isSourceBundleSelection,
} from './sprint-engine-file-actions'
import type { FileActionContext, FileActionEntry } from './renderer-host'

const root = '/Users/dev/app'

function entry(relative: string, extras: Partial<FileActionEntry> = {}): FileActionEntry {
  const name = relative.split('/').pop() ?? relative
  return { name, path: `${root}/${relative}`, isDir: false, ...extras }
}

function context(entries: FileActionEntry[]): FileActionContext {
  return { workspaceId: 'ws-1', workspaceRoot: root, entries }
}

const markdown = entry('notes/plan.md')
const backlogMarkdown = entry('backlog/plan.md')
const backlogHtml = entry('backlog/mockup.html')
const outsideHtml = entry('docs/mockup.html')

assert.equal(isSingleMarkdownPlanSelection(context([markdown])), true, 'a single markdown file is a plan selection')
assert.equal(isSingleMarkdownPlanSelection(context([backlogMarkdown])), true, 'a backlog markdown file is still a plan selection')
assert.equal(isSingleMarkdownPlanSelection(context([backlogHtml])), false, 'a single html file is not a plan selection')
assert.equal(
  isSingleMarkdownPlanSelection(context([markdown, backlogMarkdown])),
  false,
  'a multi-selection is not a plan selection',
)
assert.equal(
  isSingleMarkdownPlanSelection(context([entry('notes/plan.md', { gitDeleted: true })])),
  false,
  'a git-deleted markdown file is not a plan selection',
)

assert.equal(isSourceBundleSelection(context([backlogHtml])), true, 'a single html file is a bundle selection')
assert.equal(isSourceBundleSelection(context([backlogMarkdown, backlogHtml])), true, 'multiple source files are a bundle')
assert.equal(isSourceBundleSelection(context([markdown])), false, 'a single markdown file is not a bundle')
assert.equal(isSourceBundleSelection(context([outsideHtml])), true, 'html outside backlog is still a bundle candidate')
assert.equal(
  isSourceBundleOutsideBacklog(context([outsideHtml])),
  true,
  'html outside backlog is the disabled-constraint case',
)
assert.equal(
  isSourceBundleOutsideBacklog(context([backlogHtml])),
  false,
  'html under backlog is an enabled bundle',
)
assert.equal(
  isSourceBundleOutsideBacklog(context([backlogMarkdown, outsideHtml])),
  true,
  'a mixed selection that leaves backlog is the disabled-constraint case',
)

console.log('sprint engine file action visibility tests passed')
