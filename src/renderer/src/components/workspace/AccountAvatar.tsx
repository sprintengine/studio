import React, { useState } from 'react'
import type { SessionUser } from '../../../../shared/electron-api'

// The account identity disc (MC-2220): the provider profile photo when the
// session carries one, else two-letter initials from the display name or
// email, else a neutral person glyph. Shared by the sidebar-footer badge, the
// account popover header, and the Settings profile card, so the three cannot
// disagree about who is signed in.
//
// The photo is whatever `SessionUser.photoUrl` holds — a `data:` URL the main
// process resolved from its on-disk cache — so there is no remote load here
// and no flash while one completes. A photo that still fails to decode falls
// back to the initials silently, and stays fallen back until the URL changes.
//
// The disc owns its shape (round, clipped, centred, hairline border); the
// caller passes size, type, and colour — those differ per surface (tier tone
// in the footer, neutral chrome in Settings).

export function accountInitials(user: SessionUser | null): string {
  const source = user?.displayName?.trim() || user?.email?.trim() || ''
  if (!source) return '?'
  const words = source.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return source[0].toUpperCase()
}

// Neutral person glyph shown when no display name/email initials are available,
// so a signed-in account still reads as a coloured tier badge rather than a "?".
export function AccountUserGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.4" r="3.5" stroke="currentColor" strokeWidth={1.7} />
      <path
        d="M5.6 19c0-3.3 2.9-5.4 6.4-5.4s6.4 2.1 6.4 5.4"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
    </svg>
  )
}

type AccountAvatarProps = {
  user: SessionUser | null
  /** Size, type and colour classes for the disc (`size-control-xs text-meta …`). */
  className: string
  /** Colour as CSS variables when it is decided at runtime (the tier tone). */
  style?: React.CSSProperties
  /** Glyph class for the no-initials fallback (`icon-sm`). */
  glyphClassName: string
}

// Decorative: every surface that mounts it already names the account in text
// (the button's aria-label, the popover's name line, the profile card).
export function AccountAvatar({ user, className, style, glyphClassName }: AccountAvatarProps) {
  const photoUrl = user?.photoUrl ?? null
  const [brokenPhotoUrl, setBrokenPhotoUrl] = useState<string | null>(null)
  const showPhoto = Boolean(photoUrl) && brokenPhotoUrl !== photoUrl
  const initials = accountInitials(user)

  return (
    <span
      aria-hidden="true"
      data-account-avatar={showPhoto ? 'photo' : initials === '?' ? 'glyph' : 'initials'}
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full border font-semibold ${className}`}
      style={style}
    >
      {showPhoto ? (
        <img
          src={photoUrl ?? undefined}
          alt=""
          draggable={false}
          className="size-full object-cover"
          onError={() => setBrokenPhotoUrl(photoUrl)}
        />
      ) : initials === '?' ? (
        <AccountUserGlyph className={glyphClassName} />
      ) : (
        initials
      )}
    </span>
  )
}
