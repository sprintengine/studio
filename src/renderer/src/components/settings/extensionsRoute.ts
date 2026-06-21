// Pure settings-routing constant, kept free of any component imports so callers
// (e.g. first-run onboarding) can deep-link into Settings without pulling the
// lazy SettingsPanel/Browse component graph into their bundle.

// Settings-overlay `initialTab` value that opens the Extensions tab on its Browse
// sub-tab. `SettingsPanel` maps it to tab 'extensions' + initialSubTab 'browse'.
export const EXTENSIONS_BROWSE_DEEPLINK = 'extensions:browse'
