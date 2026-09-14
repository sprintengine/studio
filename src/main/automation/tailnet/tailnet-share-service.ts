import {
  EMPTY_TAILNET_SHARE_STATUS,
  type TailnetShareResult,
  type TailnetShareStatus,
  type TailnetShareView,
} from '../../../shared/tailnet-share'
import {
  allocateServePort,
  buildServeUrl,
  describeServeDiagnostic,
  readSelfDnsName,
  readServedPorts,
  SERVE_PORT_LADDER,
  shareLocalPort,
  unshareServePort,
  type TailscaleServeDeps,
} from './tailscale-serve'

// The service the IPC layer calls: one place that turns the serve wrapper's
// primitives into the status document every client reads.
//
// It holds NO state. Serve config lives in tailscaled, survives a Studio
// restart, and can be changed from a terminal at any moment, so every call
// re-reads it. A remembered list would be a list that lies the first time
// someone runs `tailscale serve off` by hand.

export type TailnetShareService = {
  readStatus: () => Promise<TailnetShareStatus>
  share: (localPort: number) => Promise<TailnetShareResult>
  unshare: (servePort: number) => Promise<TailnetShareResult>
}

function isUsablePort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
}

export function createTailnetShareService(deps: TailscaleServeDeps = {}): TailnetShareService {
  async function readStatus(): Promise<TailnetShareStatus> {
    const dnsName = await readSelfDnsName(deps)
    if (!dnsName) return EMPTY_TAILNET_SHARE_STATUS
    const served = await readServedPorts(deps)
    const shares: TailnetShareView[] = []
    for (const [servePort, localPort] of served) {
      shares.push({ localPort, servePort, url: buildServeUrl(dnsName, servePort) })
    }
    shares.sort((left, right) => left.localPort - right.localPort)
    return {
      available: true,
      dnsName,
      shares,
      ladderFull: SERVE_PORT_LADDER.every((port) => served.has(port)),
    }
  }

  async function refuse(message: string): Promise<TailnetShareResult> {
    return { ok: false, message, status: await readStatus() }
  }

  return {
    readStatus,

    async share(localPort: number): Promise<TailnetShareResult> {
      if (!isUsablePort(localPort)) return refuse('That is not a port this machine can share.')
      const dnsName = await readSelfDnsName(deps)
      if (!dnsName) return refuse(describeServeDiagnostic('unavailable'))
      const served = await readServedPorts(deps)
      const servePort = allocateServePort(served, localPort)
      if (servePort === null) {
        return refuse(
          `This machine is already sharing ${SERVE_PORT_LADDER.length} ports. Stop sharing one before starting another.`
        )
      }
      const result = await shareLocalPort({ localPort, servePort }, deps)
      if (!result.ok) return refuse(result.message)
      return { ok: true, share: result.share, status: await readStatus() }
    },

    async unshare(servePort: number): Promise<TailnetShareResult> {
      if (!isUsablePort(servePort)) return refuse('That is not a port this machine is sharing.')
      // Only ports this app could have handed out are ours to withdraw: a serve
      // mapping someone configured by hand — the tailnet front door included —
      // is not Studio's to take down.
      if (!SERVE_PORT_LADDER.includes(servePort)) {
        return refuse('That port was not shared from Studio, so Studio will not stop it.')
      }
      const result = await unshareServePort({ servePort }, deps)
      if (!result.ok) return refuse(result.message)
      return { ok: true, share: null, status: await readStatus() }
    },
  }
}
