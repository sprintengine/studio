import { WorkspaceTypeIcon } from '../AppIcons'
import { useProjectLogo } from '../../hooks/useProjectLogo'
import type { ModuleEnablementOverrides } from '../../../../shared/modules/manifest'
import type { Workspace } from '../../types/workspace'

// A workspace's identity in an icon slot: its project's own logo when the repo
// has one, and the workspace-type glyph when it does not (MC-2135).
//
// This exists so the logo lookup lives in ONE place. `WorkspaceTypeIcon` stays
// a leaf that takes a `logoSrc` string and knows nothing about detection, and
// call sites that render a workspace inside a `.map()` get a component they can
// use where a hook would be illegal. Surfaces that render a fixed mode rather
// than a real workspace — the mode chips in `WorkspaceLayout`, the create
// menu — keep calling `WorkspaceTypeIcon` directly: they have no project, so
// there is no logo to carry.
export function WorkspaceIdentityIcon({
  workspace,
  className,
  moduleOverrides,
}: {
  workspace: Pick<Workspace, 'mode' | 'folderPath'>
  className?: string
  moduleOverrides?: ModuleEnablementOverrides
}) {
  const logoSrc = useProjectLogo(workspace.folderPath)
  return <WorkspaceTypeIcon mode={workspace.mode} className={className} moduleOverrides={moduleOverrides} logoSrc={logoSrc} />
}
