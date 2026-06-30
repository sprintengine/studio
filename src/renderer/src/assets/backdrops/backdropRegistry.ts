// Per-theme creation-surface backdrops — the single source of truth mapping a
// resolved theme + surface to its editorial backplate URL.
//
// The file naming is deterministic (`backdrop-<theme>-<surface>.jpg`, see
// ./README.md), so the mapping is *derived*, never hand-maintained: a Vite glob
// resolves every plate to a build-hashed URL at compile time. A missing plate is
// caught by backdropRegistry.test.ts (which validates the files on disk against
// APP_THEMES), not at runtime — and `backdropFor` returns null rather than
// throwing, so a panel renders without art instead of crashing.

import { APP_THEMES, type ResolvedAppTheme } from '../../types/appTheme'

// Which creation surface a plate frames. The two plates per theme share one
// palette and differ only in medium: the workspace plate is structured
// paper-craft (NewWorkspacePanel), the chat plate is organic botanical
// (AgentChatView empty state).
export type BackdropSurface = 'workspace' | 'chat'

// Build-time URL map keyed by the glob-relative path, e.g.
// './backdrop-aubergine-chat.jpg' → '/assets/backdrop-aubergine-chat-<hash>.jpg'.
// `import.meta.glob` is a Vite compile-time macro: in the real build the call is
// statically replaced with this object literal. Under the esbuild→node test
// bundler the macro is absent, so the call throws at runtime — caught here to
// degrade to an empty map. That path is only ever hit by tests, and the real
// asset set is validated on disk by backdropRegistry.test.ts.
let assets: Record<string, string> = {}
try {
  assets = import.meta.glob('./backdrop-*.jpg', {
    eager: true,
    query: '?url',
    import: 'default',
  }) as Record<string, string>
} catch {
  assets = {}
}

// The concrete themes <html data-theme="…"> can carry. `system` is excluded —
// callers resolve it to the active light/dark theme (resolveTheme) before lookup,
// which is why it has no plates of its own.
export const RESOLVED_THEMES: readonly ResolvedAppTheme[] = APP_THEMES
  .map((theme) => theme.resolved)
  .filter((resolved): resolved is ResolvedAppTheme => resolved !== null)

// Resolved-theme + surface → plate URL, or null when no plate exists for that
// pair (the caller renders nothing). Always pass an already-resolved theme;
// 'system' has no plates.
export function backdropFor(theme: ResolvedAppTheme, surface: BackdropSurface): string | null {
  return assets[`./backdrop-${theme}-${surface}.jpg`] ?? null
}
