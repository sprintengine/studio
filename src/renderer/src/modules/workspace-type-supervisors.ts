import type {
  RegisteredWorkspaceTypeDefinition,
  WorkspaceTypeSupervisorComponent,
} from './renderer-host'

export type MountedWorkspaceTypeSupervisor = {
  key: string
  Component: WorkspaceTypeSupervisorComponent
}

export function collectWorkspaceTypeSupervisors(
  workspaceTypes: RegisteredWorkspaceTypeDefinition[],
  ownsGlobalSupervisors: boolean,
): MountedWorkspaceTypeSupervisor[] {
  return workspaceTypes.flatMap((definition) =>
    (definition.supervisors ?? [])
      .filter((supervisor) => supervisor.scope === 'all-windows' || ownsGlobalSupervisors)
      .map((supervisor, index) => ({
        key: `${definition.id}:${supervisor.scope}:${index}`,
        Component: supervisor.Component,
      }))
  )
}
