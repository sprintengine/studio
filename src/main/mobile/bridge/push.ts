import { pushTokenHash, type MobilePushRegistrationTarget } from '../sprintengine/activity'
import type {
  MobileControlDevice,
  MobilePushRegistration,
  MobilePushRegistrationInput,
} from './index'
import { randomBase64Url } from './crypto'
import {
  isMobilePushProvider,
  redactPushRegistration,
} from './validation'

const mobileControlProtocolVersion = 1 as const

export function registerMobilePushToken(
  pairedDevices: MobileControlDevice[],
  pushRegistrations: MobilePushRegistration[],
  input: MobilePushRegistrationInput
): MobilePushRegistration {
  const device = pairedDevices.find((candidate) => candidate.deviceId === input.deviceId)
  if (!device || device.revokedAt) {
    throw new Error('Push registration requires an active paired mobile device.')
  }
  if (!isMobilePushProvider(input.provider)) {
    throw new Error('Unsupported mobile push provider.')
  }

  const token = input.token.trim()
  if (token.length < 16 || token.length > 4096) {
    throw new Error('Push token length is invalid.')
  }

  const tokenHash = pushTokenHash(token)
  const existing = pushRegistrations.find((registration) =>
    registration.deviceId === device.deviceId
    && registration.provider === input.provider
    && registration.tokenHash === tokenHash
  )
  const registeredAt = new Date().toISOString()

  if (existing) {
    existing.revokedAt = undefined
    existing.registeredAt = registeredAt
    return existing
  }

  const registration: MobilePushRegistration = {
    protocolVersion: mobileControlProtocolVersion,
    registrationId: `mpr_${randomBase64Url(18)}`,
    deviceId: device.deviceId,
    provider: input.provider,
    tokenHash,
    registeredAt,
  }
  pushRegistrations.push(registration)
  return registration
}

export function revokeMobilePushRegistration(
  pushRegistrations: MobilePushRegistration[],
  registrationId: string
): MobilePushRegistration {
  const registration = pushRegistrations.find((candidate) => candidate.registrationId === registrationId)
  if (!registration) {
    throw new Error('Push registration was not found.')
  }

  registration.revokedAt = registration.revokedAt ?? new Date().toISOString()
  return registration
}

export function listMobilePushRegistrations(pushRegistrations: MobilePushRegistration[]): MobilePushRegistration[] {
  return pushRegistrations.map(redactPushRegistration)
}

export function listActiveMobilePushTargets(
  pairedDevices: MobileControlDevice[],
  pushRegistrations: MobilePushRegistration[]
): MobilePushRegistrationTarget[] {
  const activeDeviceIds = new Set(
    pairedDevices
      .filter((device) => !device.revokedAt)
      .map((device) => device.deviceId)
  )
  return pushRegistrations
    .filter((registration) => activeDeviceIds.has(registration.deviceId) && !registration.revokedAt)
    .map((registration) => ({
      deviceId: registration.deviceId,
      registrationId: registration.registrationId,
    }))
}

export function revokePushRegistrationsForDevice(
  pushRegistrations: MobilePushRegistration[],
  deviceId: string,
  revokedAt: string
): void {
  for (const registration of pushRegistrations) {
    if (registration.deviceId === deviceId && !registration.revokedAt) {
      registration.revokedAt = revokedAt
    }
  }
}
