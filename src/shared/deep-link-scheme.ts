// The URL scheme the app answers to, registered with the OS in
// `main/app-lifecycle`. Shared so the renderer can write the links main reads
// (`deep-link.ts`).
export const CURRENT_DEEP_LINK_SCHEME = 'sprintengine' as const

export const DEEP_LINK_SCHEMES = [CURRENT_DEEP_LINK_SCHEME] as const
