import { app } from 'electron'
import { access } from 'fs/promises'
import { join } from 'path'

import type { DesignSystemBrandDemoResolveResult } from '../../shared/design-system/brand-demo'

// Resolves the built-in "seed from the example design system" demo source for
// the design-system preset. The demo reads resources/design-system/example —
// the complete reference bundle that ships in the repo — which exists in dev
// checkouts but is not shipped as an extraResource, so packaged builds resolve
// to unavailable and the wizard shows the demo option disabled with that cause
// instead of seeding from an invented path.
export async function resolveDesignSystemBrandDemoSeedDir(): Promise<DesignSystemBrandDemoResolveResult> {
  const candidate = join(app.getAppPath(), 'resources', 'design-system', 'example')
  try {
    await access(candidate)
    return { ok: true, path: candidate }
  } catch {
    // Kept short: the wizard renders this verbatim as the demo card's body
    // copy, which has roughly two 12px lines before the card clips.
    return {
      ok: false,
      message: 'The example design system is not bundled with this build.',
    }
  }
}
