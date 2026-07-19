// Bridges backlog mockup attachments (MC-1485) into Sprint Engine launches: the
// mockups a plan source carries (frontmatter `mockups:` plus body-detected refs)
// become `html_mockup` source-bundle items, so the run's "Started from" seed, the
// seeded plan task's source-context block, and the architect kickoff prompt all
// name them explicitly. Pure aside from the injected reader (see
// sprintengineMockupSources.test.ts).

import { parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import {
  backlogMockupResolutionCandidates,
  collectBacklogMockups,
  parseBacklogMockups,
  resolveFirstMockupCandidate,
} from './backlogMockups'
import type { SprintEngineSourceBundleItem } from '../types/workspace'

// The mockup-bearing shape of a plan source document: a full BacklogItem
// qualifies, and a hand-picked markdown file can be adapted with `mockups: []`.
export type SprintEngineMockupSourceDoc = {
  mockups?: string[]
  sourceContent: string
  relativePath: string
}

// Adapt a raw markdown file (a source picked outside the backlog scan, where no
// parsed BacklogItem exists) into a mockup-bearing doc: the `mockups:`
// frontmatter is parsed here, body references are detected downstream.
export function mockupSourceDocFromMarkdown(
  sourceContent: string,
  relativePath: string,
): SprintEngineMockupSourceDoc {
  return {
    mockups: parseBacklogMockups(parseBacklogFrontmatter(sourceContent).fields['mockups']),
    sourceContent,
    relativePath,
  }
}

// Resolve every mockup the given source documents carry into bundle items.
// A ref may be authored project-root-relative or `backlog/`-relative
// (backlogMockupResolutionCandidates); the first candidate the reader can load
// wins, and a ref that resolves nowhere is skipped — a dangling attachment must
// not become a bundle entry the architect is told to read. Deduped across
// documents and against `excludeRelativePaths` (paths already in the bundle),
// first-seen order preserved.
export async function resolveSprintEngineMockupBundleItems(args: {
  docs: SprintEngineMockupSourceDoc[]
  folderPath: string
  readFile: (absolutePath: string) => Promise<string>
  excludeRelativePaths?: string[]
}): Promise<SprintEngineSourceBundleItem[]> {
  const { docs, folderPath, readFile, excludeRelativePaths = [] } = args
  const root = folderPath.replace(/[\\/]+$/, '')
  if (!root) return []

  const resolved = new Set(excludeRelativePaths)
  const attempted = new Set<string>()
  const items: SprintEngineSourceBundleItem[] = []

  for (const doc of docs) {
    for (const entry of collectBacklogMockups(doc)) {
      if (attempted.has(entry.path)) continue
      attempted.add(entry.path)
      // Already bundled (or resolved via another doc's ref to the same file
      // under either tolerated root): the ref names a file we have — skip it.
      if (backlogMockupResolutionCandidates(entry.path).some((candidate) => resolved.has(candidate))) {
        continue
      }
      const item = await resolveFirstMockupCandidate(entry.path, async (relativePath) => {
        const absolutePath = `${root}/${relativePath}`
        return {
          kind: 'html_mockup' as const,
          sourcePath: absolutePath,
          sourceRelativePath: relativePath,
          sourceContent: await readFile(absolutePath),
        }
      })
      if (!item) continue
      resolved.add(item.sourceRelativePath)
      items.push(item)
    }
  }

  return items
}
