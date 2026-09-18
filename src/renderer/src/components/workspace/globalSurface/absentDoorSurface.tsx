import React from 'react'

import type { RegisteredGlobalSurface, RegisteredModalSurface } from '../../../modules/renderer-host'
import { DoorModuleNotInstalledSurface } from '../ModuleAbsenceSurfaces'
import { EXTENSIONS_DRAWER_VIEWS, type ExtensionsDrawerView } from './extensions/extensionsSurfaceTarget'

// Resolution for the active door surface (MC-1854). A persisted
// `activeGlobalSurface` id whose surface never registered (module not
// installed) or whose owning module is disabled used to resolve to nothing and
// drop the region back to the workspace. It now resolves to an explicit
// not-installed door — the door name, one sentence, one CTA into Extensions —
// shaped like a registered surface so WorkspaceManager's mount path (error
// boundary, Escape exit, focus home, aria-hiding of the workspace layers)
// stays identical to every live door. Nothing here touches the store: the
// persisted id survives, so reinstalling the module lands the user back on
// the door they were in.

/**
 * The open door's human name: the label the surface registered, or — for a door
 * that names itself through its own nav-entry row instead, and for an
 * id whose surface never registered at all — the capitalised id. A registered
 * label is preferred because the two genuinely differ: the `extensions` surface
 * is called Plugins everywhere a person can read it.
 */
export function doorLabelForSurfaceId(surfaceId: string, registeredLabel?: string): string {
  const label = registeredLabel?.trim()
  if (label) return label
  return surfaceId.charAt(0).toUpperCase() + surfaceId.slice(1)
}

// The same resolution for a MODAL surface (doors→modals, 2026-09-01). A
// deep-link opener — an automations run notification whose module was toggled
// off since, say — must produce feedback, not a silent no-op: the modal opens
// on the same explainer the absent door shows, named, with the CTA into
// Plugins. The trigger glyphs never hit this (they are enablement-filtered);
// only programmatic opens do. The subset of RegisteredModalSurface the mount
// needs; no trigger fields, because nothing renders a trigger for it.
export function resolveActiveModalSurface(
  surfaceId: string,
  getSurface: (id: string) => RegisteredModalSurface | undefined,
  moduleEnabled: (moduleId: string) => boolean,
  openExtensions: (target: { view: ExtensionsDrawerView; installed?: boolean }) => void,
): Pick<RegisteredModalSurface, 'id' | 'moduleId' | 'label' | 'Component'> {
  const entry = getSurface(surfaceId)
  if (entry && moduleEnabled(entry.moduleId)) return entry
  const installed = entry !== undefined
  return {
    id: surfaceId,
    moduleId: entry?.moduleId ?? surfaceId,
    label: entry?.label ?? doorLabelForSurfaceId(surfaceId),
    Component: function AbsentModalSurface() {
      return (
        <DoorModuleNotInstalledSurface
          label={entry?.label ?? doorLabelForSurfaceId(surfaceId)}
          installed={installed}
          // A never-registered modal's id IS its module's id, which is what
          // lets the surface offer a real Install for it (G9).
          moduleId={entry?.moduleId ?? surfaceId}
          onOpenExtensions={() => openExtensions({ view: EXTENSIONS_DRAWER_VIEWS.plugins, installed })}
        />
      )
    },
  }
}

export function resolveActiveDoorSurface(
  surfaceId: string,
  getSurface: (id: string) => RegisteredGlobalSurface | undefined,
  moduleEnabled: (moduleId: string) => boolean,
  openExtensions: (target: { view: ExtensionsDrawerView; installed?: boolean }) => void,
): RegisteredGlobalSurface {
  const entry = getSurface(surfaceId)
  if (entry && moduleEnabled(entry.moduleId)) return entry
  // Registered-but-disabled means the module is on the machine, so the CTA
  // lands on the Plugins view's Installed tab, where what this machine has is
  // listed; never-registered lands on the catalogue itself.
  const installed = entry !== undefined
  return {
    id: surfaceId,
    moduleId: entry?.moduleId ?? surfaceId,
    // The name survives the module's absence: the door mount titles its region
    // and its error boundary from this, and "Extensions" where the person reads
    // "Plugins" would be a second name for the same room.
    label: doorLabelForSurfaceId(surfaceId, entry?.label),
    // An absent door brings no rail, so it must not take the sidebar column:
    // the drawer row that led here stays put, which is also the way back.
    railPlacement: 'inline',
    Component: function AbsentDoorSurface() {
      return (
        <DoorModuleNotInstalledSurface
          label={doorLabelForSurfaceId(surfaceId, entry?.label)}
          installed={installed}
          // Same rule as the modal above: a door that never registered is named
          // by its module's id, so the registry can be asked about it (G9).
          moduleId={entry?.moduleId ?? surfaceId}
          onOpenExtensions={() => openExtensions({ view: EXTENSIONS_DRAWER_VIEWS.plugins, installed })}
        />
      )
    },
  }
}
