// Pure settings-routing constants, kept free of any component imports so callers
// (first-run onboarding, the store, the learn center) can reference them without
// pulling the lazy SettingsPanel/Browse component graph into their bundle.

// Legacy settings-overlay `initialTab` value that used to open the Extensions
// tab on its Browse sub-tab. The Extensions tab folded into the Connectors
// surface (T3), so this value now routes to the Connectors surface.
export const EXTENSIONS_BROWSE_DEEPLINK = 'extensions:browse'

// Settings tab ids that folded into the Connectors surface (T3). Their browse /
// install / manage UI now lives on the Connectors surface, so a deep-link that
// once opened one of these Settings tabs opens the Connectors surface instead.
//
// `skill-packs` is kept deliberately. Skill packs themselves are gone — Skills
// is the only concept now — but deep links carrying that value are still on
// disk in older installs and in saved learn-centre actions, and they must land
// somewhere real rather than on nothing.
const CONNECTORS_FOLDED_SETTINGS_TABS = ['mcps', 'skill-packs', 'extensions'] as const

// The folded tab that asked for skills. It routes to the Skills rail row rather
// than the marketplace grid the other two land on: the packs it named are gone,
// but what it was asking for is exactly what Skills shows.
export const SKILLS_SETTINGS_TAB = 'skill-packs'

// True when a settings-overlay `initialTab` targets one of the folded tabs (or
// the legacy Extensions browse deep-link); such callers route to the Connectors
// surface rather than a Settings tab that no longer exists.
export function isConnectorsFoldedSettingsTab(initialTab: string | null | undefined): boolean {
  if (!initialTab) return false
  if (initialTab === EXTENSIONS_BROWSE_DEEPLINK) return true
  return (CONNECTORS_FOLDED_SETTINGS_TABS as readonly string[]).includes(initialTab)
}
