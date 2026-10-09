// The renderer's path to the host services a module's `entry.main` reaches
// through `getBacklogService` / `getUsageService`: the RendererHost Backlog
// write methods and `queryUsage` send their call here, and the main-process
// kernel hands it to the same moduleId-first registry the SDK helper resolves,
// which checks the module's permissions. One implementation, two doors.
//
// Like the module bridge, this is a contract rather than a security boundary:
// all renderer code shares one world, and trust gating (only trusted modules
// execute) is the boundary. The registry's permission checks are what keep a
// module to what it declared.

export const MODULE_HOST_SERVICE_CHANNEL = 'modules:host-service:invoke'

/** The services a renderer may reach this way, by the key their registry is provided under. */
export const MODULE_HOST_SERVICE_TOKENS = {
  backlog: 'backlog.module-service',
  usage: 'usage.module-service',
} as const

export type ModuleHostServiceName = keyof typeof MODULE_HOST_SERVICE_TOKENS

/** The methods a renderer may call on each, and the code a refusal answers with. */
export const MODULE_HOST_SERVICE_METHODS: Readonly<
  Record<ModuleHostServiceName, { methods: readonly string[]; unavailableCode: string }>
> = {
  backlog: {
    methods: ['getLocation', 'create', 'updateStatus', 'updateTriage', 'addLink', 'updateModuleMetadata'],
    unavailableCode: 'backlog_unavailable',
  },
  usage: { methods: ['query'], unavailableCode: 'unavailable' },
}

export type ModuleHostServiceRequest = {
  moduleId: string
  service: ModuleHostServiceName
  method: string
  args: unknown[]
}
