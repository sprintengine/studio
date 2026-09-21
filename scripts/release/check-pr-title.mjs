import { readFileSync } from 'node:fs'

import { commitBump } from './conventional-commits.mjs'

try {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  // GitHub is configured to squash with PR_TITLE and PR_BODY. Validate exactly
  // that message, including a breaking-change footer in the body.
  const bump = commitBump(`${pr.title}\n\n${pr.body ?? ''}`)
  console.log(`Conventional Commit accepted: ${bump} release`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
