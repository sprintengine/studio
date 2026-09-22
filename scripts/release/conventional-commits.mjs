// Every accepted type releases the desktop app. Maintenance changes deliberately
// mean patch here, even though Conventional Commits leaves their impact open.
export const commitTypes = ['feat', 'fix', 'perf', 'refactor', 'docs', 'style', 'test', 'build', 'ci', 'chore', 'revert']

export function commitBump(message) {
  const subject = message.split(/\r?\n/, 1)[0]
  const match = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (\S.*)$/.exec(subject)
  if (!match || !commitTypes.includes(match[1])) {
    throw new Error(`Use a Conventional Commit subject, for example "feat: add workspace search" or "fix(updates): retry downloads". Got: ${subject}`)
  }
  if (match[3] || /^BREAKING[ -]CHANGE: \S/m.test(message)) return 'major'
  return match[1] === 'feat' ? 'minor' : 'patch'
}

export function strongestBump(messages) {
  let bump = 'patch'
  for (const message of messages) {
    let next
    try {
      next = commitBump(message)
    } catch {
      // The first automated release includes history written under the former
      // prose-only policy. Only the release tip must use the new convention.
      next = /^BREAKING[ -]CHANGE: \S/m.test(message) ? 'major' : 'patch'
    }
    if (next === 'major') return 'major'
    if (next === 'minor') bump = 'minor'
  }
  return bump
}
