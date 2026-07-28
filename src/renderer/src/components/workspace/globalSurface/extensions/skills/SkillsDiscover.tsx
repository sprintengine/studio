// Discover: where a source comes from when the user does not already have a
// repository in mind. Searching GitHub from inside the app is its own work
// (the Discover view, backlog 1937); until that lands this is the honest
// version of the same destination — the two things the app can really do today:
// send the user to the topic listings on GitHub, and take a repository they
// found there.

import React from 'react'

import { GhostButton, PrimaryButton } from '../../../../ui'

const SKILL_TOPICS: ReadonlyArray<{ topic: string; url: string }> = [
  { topic: 'claude-skills', url: 'https://github.com/topics/claude-skills' },
  { topic: 'agent-skills', url: 'https://github.com/topics/agent-skills' },
]

export function SkillsDiscover({ onAddSource }: { onAddSource: () => void }): JSX.Element {
  return (
    <div className="min-w-0 max-w-[70ch]">
      <h3 className="text-[15px] font-semibold text-[color:var(--text-strong)]">Discover skills</h3>
      <p className="mt-1.5 text-[12px] leading-5 text-[color:var(--text-muted)]">
        Skills live in public repositories. Browse the topics on GitHub, then bring one back here as a
        source — Multicode walks it and finds the skills inside.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {SKILL_TOPICS.map((entry) => (
          <GhostButton
            key={entry.topic}
            className="border border-[color:var(--border-default)]"
            onClick={() => void window.api.openExternal(entry.url)}
          >
            {`github.com/topics/${entry.topic}`}
          </GhostButton>
        ))}
        <PrimaryButton onClick={onAddSource}>Add a source</PrimaryButton>
      </div>
    </div>
  )
}
