import {
  MODULE_HOST_SERVICE_METHODS,
  MODULE_HOST_SERVICE_TOKENS,
  type ModuleHostServiceName,
} from '../../shared/modules/host-service-bridge'

// The main end of the renderer's host-service door (shared/modules/
// host-service-bridge.ts): resolve the registry the SDK helper would, and call
// it with the calling module's id first. Every answer is data — a registry's
// own result, or a refusal in that registry's vocabulary — because Electron
// turns a thrown error into an opaque string on the way back.

type Refusal = { ok: false; code: string; message: string }

export function createModuleHostServiceDispatcher(
  getService: (key: string) => unknown,
): (event: unknown, request: unknown) => Promise<unknown> {
  return async (_event, request) => {
    const call = (request ?? {}) as { moduleId?: unknown; service?: unknown; method?: unknown; args?: unknown }
    const service = typeof call.service === 'string' ? call.service : ''
    if (!Object.hasOwn(MODULE_HOST_SERVICE_TOKENS, service)) {
      return refusal('unavailable', `There is no host service "${service}" a module can call.`)
    }
    const name = service as ModuleHostServiceName
    const { methods, unavailableCode } = MODULE_HOST_SERVICE_METHODS[name]
    const method = typeof call.method === 'string' ? call.method : ''
    if (!methods.includes(method)) {
      return refusal('invalid_input', `The ${name} service has no method "${method}" a module can call.`)
    }
    if (typeof call.moduleId !== 'string' || !call.moduleId.trim()) {
      return refusal('invalid_input', 'The calling module is not named.')
    }
    const registry = getService(MODULE_HOST_SERVICE_TOKENS[name]) as Record<string, unknown> | undefined
    const target = registry?.[method]
    if (typeof target !== 'function') {
      return refusal(unavailableCode, `The ${name} service is not available in this app.`)
    }
    const args = Array.isArray(call.args) ? call.args : []
    try {
      return await (target as (...input: unknown[]) => unknown).call(registry, call.moduleId, ...args)
    } catch (error) {
      return refusal(unavailableCode, error instanceof Error ? error.message : String(error))
    }
  }
}

function refusal(code: string, message: string): Refusal {
  return { ok: false, code, message }
}
