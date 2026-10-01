import type { RegisterRenderer, WorkspaceCreationStepProps } from '@sprintengine/module-sdk'
import { Field, Input } from '@sprintengine/module-sdk/ui'

import { createBriefPanel, type Brief } from './BriefPanel'

const WORKSPACE_TYPE_ID = '{{id}}'
const PANEL_ID = '{{id}}.brief'

type StepValue = { goal?: string; error?: string }

const readStep = (value: unknown): StepValue =>
  typeof value === 'object' && value !== null ? (value as StepValue) : {}

function TypeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

// The creation hub shows this page after the shared name and folder fields.
// Its value lives only while the hub is open; `createWorkspace` below is
// where it becomes the workspace's own state.
function GoalStep({ value, setValue }: WorkspaceCreationStepProps) {
  const step = readStep(value)
  return (
    <Field label="What is this workspace for?" htmlFor="{{id}}-goal" error={step.error}>
      <Input
        id="{{id}}-goal"
        value={step.goal ?? ''}
        onChange={(event) => setValue({ goal: event.target.value })}
        placeholder="Ship the settings redesign"
        fullWidth
      />
    </Field>
  )
}

export const registerRenderer: RegisterRenderer = (host) => {
  host.registerPanel(PANEL_ID, createBriefPanel(host))
  host.registerWorkspaceType({
    id: WORKSPACE_TYPE_ID,
    label: '{{displayName}}',
    description: 'A project workspace that keeps its goal in view.',
    icon: TypeIcon,
    creationStep: {
      id: 'goal',
      heading: 'Goal',
      description: 'One line the workspace keeps in front of you.',
      Component: GoalStep,
      isReady: (value) => (readStep(value).goal ?? '').trim().length > 0,
      blockedHint: 'Say what the workspace is for.',
    },
    createTemplate: () => ({
      id: WORKSPACE_TYPE_ID,
      name: '{{displayName}}',
      description: 'The brief panel.',
      previewSlots: [{ x: 0, y: 0, w: 1, h: 1, type: 'editor', label: 'Brief' }],
      layout: {
        layout: {
          type: 'row',
          children: [{ type: 'tabset', children: [{ type: 'tab', name: 'Brief', component: PANEL_ID }] }],
        },
      },
    }),
    // Creation that must do something after the row exists: mint it, write the
    // goal into the workspace's module state, and take the row back if that
    // write fails, so a failed create leaves nothing behind.
    async createWorkspace(request, create) {
      const goal = (readStep(request.stepValue).goal ?? '').trim()
      const workspaceId = create.createWorkspace({ name: request.name.trim() || goal })
      const brief: Brief = { goal, createdAt: new Date().toISOString() }
      if (!host.setWorkspaceModuleState(workspaceId, brief)) {
        create.removeWorkspace(workspaceId)
        request.setStepValue({ goal, error: 'Studio could not save the goal. Try again.' })
        throw new Error('The workspace goal was not stored.')
      }
    },
  })
}
