import { readStudioEnvironmentId } from '../../main/studio-rpc/studio-rpc-service'
import { startStudioServer, type StudioServerOptions } from '../studio-server'
import { SERVER_EXIT, type ServerBootstrapEnvelope } from './envelope'
import type { ServerStart } from './serve'

// A headless server's start from its envelope: the same core, gateway and
// owner socket `studio-server serve` runs, with the locations the envelope
// names instead of flags. Its secrets are its own key file (decision R12);
// a headless server never seals through a shell.

export function headlessServerOptions(
  envelope: ServerBootstrapEnvelope,
  log: (message: string) => void,
): StudioServerOptions {
  return {
    dataDir: envelope.dataDir,
    logsDir: envelope.logsDir,
    version: envelope.app.version,
    packaged: envelope.paths.isPackaged,
    resourcesDir: envelope.paths.resourcesDir,
    appRoot: envelope.paths.appPath,
    listen: envelope.listeners.gateway,
    log,
  }
}

export const startHeadlessServer: ServerStart = async ({ envelope, log, requestExit }) => {
  const server = await startStudioServer({
    ...headlessServerOptions(envelope, log),
    // The desktop opened this directory and took its lock: it is the one
    // writer now, and this server leaves saying so.
    onDataDirLost: () =>
      requestExit(SERVER_EXIT.dataDirBusy, 'SprintEngine Studio opened this data directory; stopping.'),
  })
  return {
    environmentId: readStudioEnvironmentId(envelope.dataDir),
    gatewaySocket: server.ready.gatewaySocket,
    tailnetBound: null,
    stop: ({ onLeg }) => server.stop(onLeg),
  }
}
