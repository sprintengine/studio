// Registers the app's real typefaces (Inter + JetBrains Mono) with Remotion's
// headless renderer so every frame renders in the product's actual fonts
// instead of a Chromium system-font substitute. The product is Inter + JetBrains
// Mono (src/renderer/src/assets/index.css, knowledge/brand/BRAND-APP.md).
//
// `loadFont` self-manages delayRender/continueRender per face — see
// @remotion/google-fonts/dist/cjs/base.js — so a module-scope call is
// render-safe with no manual handles. Weights + the `latin` subset are pinned
// to keep the per-render font-request count low and the render deterministic
// (the film's copy is ASCII; loading every weight × subset triggers a
// too-many-requests warning and adds render time).

import { loadFont as loadInter } from '@remotion/google-fonts/Inter'
import { loadFont as loadJetBrainsMono } from '@remotion/google-fonts/JetBrainsMono'

loadInter('normal', { weights: ['400', '500', '600', '700'], subsets: ['latin'] })
loadJetBrainsMono('normal', { weights: ['400', '500'], subsets: ['latin'] })

export const SANS_FAMILY = 'Inter'
export const MONO_FAMILY = 'JetBrains Mono'
