import type { BacklogItemActionContext, RegisterRenderer } from '@sprintengine/module-sdk'

const isClosed = (context: BacklogItemActionContext) =>
  context.item.status === 'completed' || context.item.status === 'archived'

// An action in a Backlog item's right-click menu and in its detail header's
// More-actions menu, under this module's name. It opens a new chat in the
// item's workspace with a planning prompt as a DRAFT: the person reads it,
// picks the agent, and sends it. Pass `send: true` to send it for them.
export const registerRenderer: RegisterRenderer = (host) => {
  host.registerBacklogItemAction({
    id: 'plan-in-chat',
    label: 'Plan in a chat',
    category: 'execute',
    getState: (context) => (isClosed(context) ? 'disabled' : 'enabled'),
    async run(context) {
      const { item } = context
      const opened = await host.openChat({
        workspaceId: context.workspaceId,
        prompt: [
          `Plan the work for the Backlog item "${item.title}" (${item.relativePath}).`,
          'Read the item first. Propose the steps and the files they touch, and wait for my go-ahead before changing anything.',
        ].join('\n\n'),
      })
      if (!opened.ok) window.alert(`{{displayName}} could not open a chat: ${opened.message}`)
    },
  })
}
