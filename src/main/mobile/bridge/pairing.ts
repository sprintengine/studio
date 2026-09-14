import {
  isSupportedMobileControlProtocolVersion,
  type MobileControlProtocolVersion,
} from '../../../shared/mobile-control/protocol'

type PairingPayload = {
  mobileControlProtocolVersion: MobileControlProtocolVersion
  pairingChallengeId: string
  relayUrl: string
  pairingSecret: string
  expiresAt: string
  desktop: {
    displayName: string
    desktopInstanceId: string
    desktopRelaySessionId: string
  }
}

type PairingChallengeLike = {
  manualPairingCode?: string
  pairingUri: string
  pairingPayload?: PairingPayload
}

export function manualPairingValueFromRelayChallenge(challenge: PairingChallengeLike): string {
  if (challenge.manualPairingCode) return challenge.manualPairingCode

  if (!challenge.pairingPayload) {
    if (isSupportedMobilePairingUri(challenge.pairingUri)) return challenge.pairingUri
    throw new Error('Relay pairing challenge did not include a mobile-compatible pairing link.')
  }

  let url: URL
  try {
    url = new URL(challenge.pairingUri)
  } catch {
    url = new URL('multicode://mobile/pair')
  }

  url.searchParams.set('mobileControlProtocolVersion', String(challenge.pairingPayload.mobileControlProtocolVersion))
  url.searchParams.set('pairingChallengeId', challenge.pairingPayload.pairingChallengeId)
  url.searchParams.set('relayUrl', challenge.pairingPayload.relayUrl)
  url.searchParams.set('pairingSecret', challenge.pairingPayload.pairingSecret)
  url.searchParams.set('expiresAt', challenge.pairingPayload.expiresAt)
  url.searchParams.set('desktopName', challenge.pairingPayload.desktop.displayName)
  url.searchParams.set('desktopInstanceId', challenge.pairingPayload.desktop.desktopInstanceId)
  url.searchParams.set('desktopRelaySessionId', challenge.pairingPayload.desktop.desktopRelaySessionId)

  return url.toString()
}

/**
 * Is this link one a phone this desktop still talks to could have produced?
 *
 * The version window rather than the current version alone: the link is handed
 * straight to a phone, and refusing one stamped a release behind would make
 * pairing the single thing an otherwise-working older phone could not do.
 */
function isSupportedMobilePairingUri(pairingUri: string): boolean {
  try {
    const params = new URL(pairingUri).searchParams
    return isSupportedMobileControlProtocolVersion(Number(params.get('mobileControlProtocolVersion')))
      && Boolean(params.get('pairingChallengeId')?.trim())
      && Boolean(params.get('relayUrl')?.trim() || params.get('relay')?.trim())
      && Boolean(params.get('pairingSecret')?.trim())
      && Boolean(params.get('expiresAt')?.trim())
      && Boolean((params.get('desktopName') ?? params.get('desktopDisplayName'))?.trim())
      && Boolean(params.get('desktopInstanceId')?.trim())
  } catch {
    return false
  }
}
