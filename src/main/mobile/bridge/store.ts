import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type {
  MobileControlDevice,
  MobilePushRegistration,
} from './index'
import { randomBase64Url } from './crypto'
import {
  isMobileControlDevice,
  isMobilePushRegistration,
} from './validation'

export type MobileBridgeStoredState = {
  enabled: boolean
  desktopInstanceId: string
  pairedDevices: MobileControlDevice[]
  pushRegistrations: MobilePushRegistration[]
}

type PersistedMobileBridgeState = {
  enabled?: boolean
  desktopInstanceId?: string
  pairedDevices?: unknown[]
  pushRegistrations?: unknown[]
}

export function getDefaultMobileBridgeStorePath(): string {
  return join(app.getPath('userData'), 'mobile-bridge.json')
}

export async function readMobileBridgeStore(storePath: string): Promise<MobileBridgeStoredState> {
  try {
    const payload = JSON.parse(await readFile(storePath, 'utf8')) as PersistedMobileBridgeState
    return {
      enabled: payload.enabled === true,
      desktopInstanceId: typeof payload.desktopInstanceId === 'string' && payload.desktopInstanceId
        ? payload.desktopInstanceId
        : `mdi_${randomBase64Url(18)}`,
      pairedDevices: Array.isArray(payload.pairedDevices)
        ? payload.pairedDevices.flatMap((device) => {
            return isMobileControlDevice(device) ? [device] : []
          })
        : [],
      pushRegistrations: Array.isArray(payload.pushRegistrations)
        ? payload.pushRegistrations.flatMap((registration) => {
            return isMobilePushRegistration(registration) ? [registration] : []
          })
        : [],
    }
  } catch {
    return {
      enabled: false,
      desktopInstanceId: `mdi_${randomBase64Url(18)}`,
      pairedDevices: [],
      pushRegistrations: [],
    }
  }
}

export async function writeMobileBridgeStore(storePath: string, state: MobileBridgeStoredState): Promise<void> {
  await mkdir(dirname(storePath), { recursive: true })
  const payload: PersistedMobileBridgeState = {
    enabled: state.enabled,
    desktopInstanceId: state.desktopInstanceId,
    pairedDevices: state.pairedDevices,
    pushRegistrations: state.pushRegistrations,
  }
  await writeFile(storePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}
