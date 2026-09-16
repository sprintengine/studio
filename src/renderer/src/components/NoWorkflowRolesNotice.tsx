import { InlineNotice } from './ui'
import {
  NO_WORKFLOW_ROLES_HEAD,
  NO_WORKFLOW_ROLES_REMEDIES,
} from '../../../shared/workflow-roles'

/** The empty-pack error, the same card on every role picker. */
export function NoWorkflowRolesNotice({ className }: { className?: string }): JSX.Element {
  return (
    <InlineNotice tone="error" title={NO_WORKFLOW_ROLES_HEAD} className={className}>
      {NO_WORKFLOW_ROLES_REMEDIES}
    </InlineNotice>
  )
}
