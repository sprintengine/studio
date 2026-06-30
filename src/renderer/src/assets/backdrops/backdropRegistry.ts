// Per-theme creation-surface backdrops — the single source of truth mapping a
// resolved theme + surface to its editorial backplate URL.
//
// The file naming is deterministic (`backdrop-<theme>-<surface>.jpg`, see
// ./README.md), so the mapping is *derived*, never hand-maintained: Vite globs
// resolve both the standard and 4K plates to build-hashed URLs at compile time.
// A missing plate is caught by backdropRegistry.test.ts (which validates the
// files on disk against APP_THEMES), not at runtime — and `backdropFor` returns
// null rather than throwing, so a panel renders without art instead of crashing.

import { APP_THEMES, type ResolvedAppTheme } from "../../types/appTheme";

// Which creation surface a plate frames. The two plates per theme share one
// palette and differ only in medium: the workspace plate is structured
// paper-craft (NewWorkspacePanel), the chat plate is organic botanical
// (AgentChatView empty state).
export type BackdropSurface = "workspace" | "chat";

export interface BackdropSources {
  standard: string;
  fourK: string;
}

// Build-time URL map keyed by the glob-relative path, e.g.
// './backdrop-aubergine-chat.jpg' → '/assets/backdrop-aubergine-chat-<hash>.jpg'.
// `import.meta.glob` is a Vite compile-time macro: in the real build the call is
// statically replaced with this object literal. Under the esbuild→node test
// bundler the macro is absent, so the call throws at runtime — caught here to
// degrade to an empty map. That path is only ever hit by tests, and the real
// asset set is validated on disk by backdropRegistry.test.ts.
let standardAssets: Record<string, string> = {};
let fourKAssets: Record<string, string> = {};
try {
  standardAssets = import.meta.glob("./backdrop-*.jpg", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>;
  fourKAssets = import.meta.glob("./4k/backdrop-*.jpg", {
    eager: true,
    query: "?url",
    import: "default",
  }) as Record<string, string>;
} catch {
  standardAssets = {};
  fourKAssets = {};
}

// The concrete themes <html data-theme="…"> can carry. `system` is excluded —
// callers resolve it to the active light/dark theme (resolveTheme) before lookup,
// which is why it has no plates of its own.
export const RESOLVED_THEMES: readonly ResolvedAppTheme[] = APP_THEMES.map(
  (theme) => theme.resolved,
).filter((resolved): resolved is ResolvedAppTheme => resolved !== null);

// Resolved-theme + surface → responsive plate URLs, or null when no standard
// plate exists for that pair (the caller renders nothing). The 4K URL falls back
// to the standard plate defensively; the completeness test requires both.
// Always pass an already-resolved theme; 'system' has no plates.
export function backdropFor(
  theme: ResolvedAppTheme,
  surface: BackdropSurface,
): BackdropSources | null {
  const filename = `backdrop-${theme}-${surface}.jpg`;
  const standard = standardAssets[`./${filename}`];
  if (!standard) return null;

  return {
    standard,
    fourK: fourKAssets[`./4k/${filename}`] ?? standard,
  };
}
