// A third external module compiled against the packed tarball only: the
// host-bridged UI kit, door shell and Monaco (D6). It proves three things the
// other fixtures cannot:
//
//   1. `@sprintengine/module-sdk/ui` and `@sprintengine/module-sdk/surface` resolve
//      as published subpath entry points (the tarball's `exports` map), not
//      just as files that happen to be in `dist/`.
//   2. Their props typecheck as a module author would actually write them.
//   3. `@monaco-editor/react` is a plain dependency of the module and is
//      bridged by the host, so a review-style diff view needs no Monaco copy
//      of its own.
//
// Every one of these specifiers is supplied by the host at runtime and MUST be
// marked external when the module is bundled:
//
//   esbuild src/renderer.tsx --bundle --format=esm \
//     --external:react --external:react-dom --external:react-dom/client \
//     --external:react/jsx-runtime \
//     --external:@monaco-editor/react \
//     --external:@sprintengine/module-sdk/ui \
//     --external:@sprintengine/module-sdk/surface
//
// verify-module-sdk-pack.mjs runs exactly that bundle over this file and fails
// if a stub was inlined instead of externalised.

import { createElement } from 'react'
import { DiffEditor } from '@monaco-editor/react'

import type { GlobalSurfaceComponent, RegisterRenderer } from '@sprintengine/module-sdk'
import {
  Banner,
  EmptyState,
  PrimaryButton,
  Select,
  type SelectItem,
  type Tone,
} from '@sprintengine/module-sdk/ui'
import {
  GlobalSurfaceShell,
  SurfaceCanvasState,
  SurfaceRail,
  useSurfaceBackNav,
  type SurfaceRailRow,
} from '@sprintengine/module-sdk/surface'

const BRANCHES: SelectItem<string>[] = [
  { value: 'main', label: 'main' },
  { value: 'topic', label: 'topic', tone: 'accent' satisfies Tone },
]

const ROWS: SurfaceRailRow[] = [
  { id: 'r1', title: 'Rename the ledger column', stateLine: '3 files · 2 unread' },
]

const ReviewsDoor: GlobalSurfaceComponent = () => {
  const { onBack, canGoBack } = useSurfaceBackNav()
  return createElement(GlobalSurfaceShell, {
    ariaLabel: 'Reviews',
    bar: { title: 'Reviews', actions: createElement(PrimaryButton, { children: 'New review' }) },
    onBack,
    canGoBack,
    rail: createElement(SurfaceRail, {
      label: 'Reviews',
      rows: ROWS,
      selectedId: 'r1',
      onSelect: () => {},
      newAffordance: { label: 'New review', onActivate: () => {} },
      search: {
        value: '',
        onChange: () => {},
        placeholder: 'Search reviews',
        ariaLabel: 'Search reviews',
      },
    }),
    children: [
      createElement(Banner, {
        key: 'banner',
        tone: 'warn',
        message: 'Branch moved on',
        onRetry: () => {},
      }),
      createElement(Select, {
        key: 'branch',
        ariaLabel: 'Branch',
        items: BRANCHES,
        value: 'main',
        onChange: () => {},
      }),
      createElement(DiffEditor, {
        key: 'diff',
        original: 'a\n',
        modified: 'b\n',
        language: 'typescript',
        theme: 'vs-dark',
      }),
      createElement(SurfaceCanvasState, {
        key: 'canvas',
        kind: 'empty',
        glyph: null,
        title: 'Nothing to review',
        action: createElement(EmptyState, { key: 'cta', title: 'Pick a branch' }),
      }),
    ],
  })
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerGlobalSurface({ id: 'reviews-fixture', Component: ReviewsDoor })
}
