import type { RendererHost } from './renderer-host'
import type { LayoutTemplate, PreviewSlot } from '../types/workspace'
import { REVIEW_WORKSPACE_MODE } from '../types/workspace'
import { ReviewWorkspaceTypeIcon } from '../components/AppIcons'

const editor = (label: string, x: number, y: number, w: number, h: number): PreviewSlot => ({ x, y, w, h, type: 'editor', label })

// A review workspace is a single surface: one non-closeable Review tab whose
// tabset hides the FlexLayout strip, so ReviewPanel owns the whole pane (mirrors
// the Automations / Switchboard single-surface pattern). The layout is fixed and
// comes from this factory — there is no `layoutModel` ladder arm for it.
const reviewTab = () => ({
  type: 'tab',
  name: 'Review',
  component: 'review',
  enableClose: false,
})

export function createReviewTemplate(): LayoutTemplate {
  return {
    id: 'review-mode',
    name: 'Review',
    description: 'Guided walkthrough of a pull request, branch, or patch — your change set, read and organized for review.',
    previewSlots: [editor('Review', 4, 4, 292, 102)],
    layout: {
      global: { tabSetEnableDrop: true, tabEnableClose: true },
      borders: [],
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            weight: 100,
            enableTabStrip: false,
            children: [reviewTab()],
          },
        ],
      },
    },
  }
}

export function registerReviewWorkspaceType(host: RendererHost): void {
  host.registerWorkspaceType({
    id: REVIEW_WORKSPACE_MODE,
    label: 'Review',
    description: 'Guided walkthrough of a pull request, branch, or patch',
    icon: ReviewWorkspaceTypeIcon,
    accentToken: '--accent-primary',
    searchTerms: ['review', 'pull request', 'pr', 'diff', 'code review', 'walkthrough'],
    createTemplate: createReviewTemplate,
    // One source step after name/folder; the fixed single-surface template means
    // no layout-picker step (same zero-config shape as Automations).
    creationStepsId: 'review',
    pickerOrder: 25,
  })
}
