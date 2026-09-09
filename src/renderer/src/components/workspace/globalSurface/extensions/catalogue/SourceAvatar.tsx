// A source's mark at the head of its tab: the GitHub owner's avatar when the
// source is a repository — the same picture the person sees on github.com —
// and the monogram chip otherwise. A source has no artwork of its own, but the
// account that publishes it does, and that is what makes "Anthropic" read as
// Anthropic rather than as two letters in a box.
//
// The avatar is fetched from GitHub's public avatar redirect, which needs no
// token. Until it lands, and if it never does, the monogram stands in — so the
// head never shows an empty square.

import React, { useState } from 'react'

import type { SkillSource } from '../../../../../../../shared/skills'
import { ExtensionIcon } from '../../../../ui/ExtensionIcon'

/** The GitHub account a repository belongs to, or '' for a source with none. */
export function sourceOwner(source: Pick<SkillSource, 'kind' | 'repo'>): string {
  if (source.kind !== 'github') return ''
  const owner = source.repo.split('/')[0] ?? ''
  return /^[A-Za-z0-9-]+$/.test(owner) ? owner : ''
}

export function sourceAvatarUrl(source: Pick<SkillSource, 'kind' | 'repo'>, size: number): string | null {
  const owner = sourceOwner(source)
  return owner ? `https://github.com/${owner}.png?size=${size * 2}` : null
}

export function SourceAvatar({
  source,
  monogram,
  size = 48,
}: {
  source: Pick<SkillSource, 'kind' | 'repo'>
  monogram: string
  size?: number
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const url = failed ? null : sourceAvatarUrl(source, size)
  if (!url) return <ExtensionIcon name={monogram} size={size} />
  return (
    <img
      src={url}
      alt=""
      aria-hidden
      width={size}
      height={size}
      decoding="async"
      onError={() => setFailed(true)}
      className="pointer-events-none shrink-0 select-none rounded-lg border border-[color:var(--icon-chip-border)] object-cover"
    />
  )
}
