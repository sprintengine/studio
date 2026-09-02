import { FolderTypeIcon } from '../AppIcons'
import { useProjectLogo } from '../../hooks/useProjectLogo'

// A folder header's identity in its icon slot: the project's own logo when the
// repo at that path has one at its top level, and the folder glyph when it does
// not (MC-2135, re-sited by the owner on 2026-09-02).
//
// This exists so the logo lookup lives in ONE place. `FolderTypeIcon` stays a
// leaf that takes a `logoSrc` string and knows nothing about detection, and the
// sidebar — which renders its folder headers inside a `.map()`, where a hook
// would be illegal — gets a component it can use there. It replaces
// `WorkspaceIdentityIcon`: the logo used to hang off every workspace row, which
// repeated one project's mark once per chat; it now hangs off the one header
// that names the project.
export function FolderIdentityIcon({
  folderPath,
  className,
}: {
  folderPath: string | null | undefined
  className?: string
}) {
  const logoSrc = useProjectLogo(folderPath)
  return <FolderTypeIcon className={className} logoSrc={logoSrc} />
}
