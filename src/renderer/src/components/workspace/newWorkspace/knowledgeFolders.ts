import { resolveProjectKnowledgeConfig } from '../../../utils/projectKnowledge'
import { joinPath } from './helpers'

// Conventional knowledge-graph folder names probed when the wizard reaches the
// knowledge step, ordered by preference. These are deliberately high-signal: the
// brand convention (knowledge/) and its close variants — not generic trees like
// docs/, which are usually API/user docs rather than a knowledge graph and would
// point agents at the wrong place. The top existing match is auto-applied as the
// default; users can still type or pick any folder manually.
export const KNOWLEDGE_FOLDER_CANDIDATES = [
  'knowledge',
  '.knowledge',
  'knowledge-base',
] as const

// Names confident enough to apply without the user asking. Kept as a separate
// set so a weaker, suggestion-only tier can be reintroduced later without
// changing call sites.
export const STRONG_KNOWLEDGE_CANDIDATES: ReadonlySet<string> = new Set(KNOWLEDGE_FOLDER_CANDIDATES)

export type KnowledgeCandidate = {
  /** Folder name relative to the project root, e.g. `knowledge`. */
  name: string
  /** Absolute path probed for existence. */
  path: string
  /** Strong candidates are auto-applied; weak ones are only suggested. */
  strong: boolean
}

/** Absolute candidate paths to probe for an existing knowledge folder. */
export function knowledgeCandidatePaths(projectRoot: string): KnowledgeCandidate[] {
  return KNOWLEDGE_FOLDER_CANDIDATES.map((name) => ({
    name,
    path: joinPath(projectRoot, name),
    strong: STRONG_KNOWLEDGE_CANDIDATES.has(name),
  }))
}

/**
 * Whether the create-workspace wizard should include the knowledge step for the
 * chosen folder. We only prompt for a *new* project: when the folder already
 * resolves to a configured (or inherited) knowledge root, its workspaces share
 * that project config and re-prompting would be noise. No folder yet → no step
 * (the picker stores a path relative to the project folder, so it needs one).
 */
export function shouldShowKnowledgeStep(
  folderPath: string | null | undefined,
  projectKnowledgeRoots: Record<string, string | null> | null | undefined,
): boolean {
  if (!folderPath || !folderPath.trim()) return false
  return resolveProjectKnowledgeConfig(folderPath, projectKnowledgeRoots, null) == null
}
