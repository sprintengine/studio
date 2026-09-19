/**
 * The Electron half of the background-mode tray — everything
 * `background-presence.ts` deliberately does not import, so the last-window-
 * close decision stays testable without a display.
 */
import { app, Menu, nativeImage, Tray } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

import { runBackgroundTrayAction, type BackgroundTrayItem } from '../shared/background-mode'
import type { BackgroundTrayActions, BackgroundTrayHandle } from './background-presence'

// Menu-bar / notification-area icons render at 16 px (32 px @2x); the shipped
// app icon is a 1024 px PNG, so it is resized here rather than at paint time.
const TRAY_ICON_SIZE = 16

/**
 * The app icon, from the same file electron-builder uses for the Linux icon.
 * Packaged builds get it via the `resources/icon.png` extraResources entry.
 */
function resolveTrayIconPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'icon.png')
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', 'icon.png'),
    join(app.getAppPath(), 'resources', 'icon.png'),
    join(__dirname, '..', '..', 'resources', 'icon.png'),
    join(__dirname, '..', '..', '..', 'resources', 'icon.png'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Build the real tray. Returns null when Electron refuses one (no display, no
 * supported desktop environment) — the caller treats that as "no affordance",
 * never as "do not stay running".
 */
export function createElectronBackgroundTray(): BackgroundTrayHandle | null {
  const iconPath = resolveTrayIconPath()
  const image = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
    : nativeImage.createEmpty()
  let tray: Tray
  try {
    tray = new Tray(image)
  } catch {
    return null
  }
  // An empty image is an invisible menu-bar item — a presence the user cannot
  // find is the same as no presence. macOS renders a text title beside (or in
  // place of) the icon, so fall back to one rather than shipping a ghost.
  if (image.isEmpty() && process.platform === 'darwin') tray.setTitle('SprintEngine')
  return {
    setToolTip: (text) => tray.setToolTip(text),
    setContextMenu: (menu) => tray.setContextMenu(menu as Menu),
    on: (event, listener) => {
      // Electron types these two events separately, so the union has to be
      // narrowed rather than forwarded.
      if (event === 'click') tray.on('click', listener)
      else tray.on('right-click', listener)
    },
    destroy: () => tray.destroy(),
  }
}

/** Render the pure item list into an Electron menu. */
export function buildElectronBackgroundMenu(
  items: readonly BackgroundTrayItem[],
  actions: BackgroundTrayActions,
): Menu {
  return Menu.buildFromTemplate(
    items.map((item) => {
      if (item.kind === 'separator') return { type: 'separator' as const }
      if (item.kind === 'info') return { label: item.label ?? '', enabled: false }
      return {
        label: item.label ?? '',
        click: () => runBackgroundTrayAction(item.id, actions),
      }
    }),
  )
}
