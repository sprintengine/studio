// The URL schemes the app answers to.
//
// `sprintengine` is the only one anything here writes into a new link. The app
// shipped under the old name until 2026-09-08, and the old scheme stays
// registered and accepted because a deep link outlives the build that minted
// it: a pairing link sitting unread in a phone's inbox, an authorization
// already round-tripping through an issuer, and — on macOS, where
// LaunchServices binds a scheme to a bundle rather than to a version — an older
// install that still holds the registration. Dropping it turns those into "no
// application can open this link", which is a failure the app never gets to
// see, let alone report.
//
// Both are registered with the OS in `app-lifecycle`, and every place that
// parses an incoming link accepts both. Generation is the asymmetry: read both,
// write one.
export const CURRENT_DEEP_LINK_SCHEME = 'sprintengine' as const
export const LEGACY_DEEP_LINK_SCHEME = 'multicode' as const

export const DEEP_LINK_SCHEMES = [CURRENT_DEEP_LINK_SCHEME, LEGACY_DEEP_LINK_SCHEME] as const
