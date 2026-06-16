import assert from 'node:assert/strict'

import {
  KNOWLEDGE_FOLDER_CANDIDATES,
  knowledgeCandidatePaths,
  shouldShowKnowledgeStep,
} from './knowledgeFolders'

// Candidate paths are the conventional names joined onto the project root, with
// strong names flagged for auto-apply.
{
  const candidates = knowledgeCandidatePaths('/Users/me/project')
  assert.deepEqual(
    candidates.map((c) => c.name),
    [...KNOWLEDGE_FOLDER_CANDIDATES],
    'candidate order is preserved',
  )
  assert.equal(candidates[0].path, '/Users/me/project/knowledge', 'paths are joined onto the project root')
  assert.equal(candidates[0].strong, true, 'knowledge is a strong candidate')
  assert.ok(
    candidates.every((c) => c.strong),
    'all probed candidates are high-signal (no generic docs/ tier)',
  )
  assert.ok(
    candidates.every((c) => c.name !== 'docs'),
    'docs is not probed — it is usually API/user docs, not a knowledge graph',
  )
}

// Windows-style roots keep their separator when joining.
{
  const [first] = knowledgeCandidatePaths('C:\\code\\app')
  assert.equal(first.path, 'C:\\code\\app\\knowledge', 'backslash roots join with a backslash')
}

// New project (no configured/inherited root) with a folder → show the step.
assert.equal(
  shouldShowKnowledgeStep('/Users/me/project', {}),
  true,
  'a new project with a chosen folder shows the step',
)

// No folder yet → no step (the picker needs a project root to be relative to).
assert.equal(shouldShowKnowledgeStep(null, {}), false, 'no folder hides the step')
assert.equal(shouldShowKnowledgeStep('   ', {}), false, 'blank folder hides the step')

// Folder already configured for itself → skip (workspaces share the config).
assert.equal(
  shouldShowKnowledgeStep('/Users/me/project', { '/users/me/project': 'knowledge' }),
  false,
  'an already-configured project skips the step',
)

// Folder inheriting an ancestor's configured root → skip too.
assert.equal(
  shouldShowKnowledgeStep('/Users/me/project/apps/web', { '/users/me/project': 'knowledge' }),
  false,
  'a project inheriting an ancestor root skips the step',
)

// A sibling/unrelated configured root must not suppress the step.
assert.equal(
  shouldShowKnowledgeStep('/Users/me/project', { '/users/me/other': 'knowledge' }),
  true,
  'an unrelated configured root does not affect this project',
)

console.log('knowledge step helper tests passed')
