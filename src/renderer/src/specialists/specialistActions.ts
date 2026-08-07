// Specialist prompt composition moved to `src/shared/specialists/specialist-actions.ts`
// when the main-process AgentLaunchService took over launch composition
// (MC-2159): main has to build the same soul-fetch preamble the renderer does,
// and duplicating it would let the two drift. This shim keeps every renderer
// import path working.
//
// What stays here is the one function that genuinely needs the renderer: reading
// a rendered Soul over IPC. Everything around it — the action shape, the
// ordering, the prompt builders — is string work over ids and lives in shared.
import type { SpecialistActionId } from '../types/workspace'
import {
  buildMissingSpecialistSoul,
  getSpecialistAction,
} from '../../../shared/specialists/specialist-actions'

export * from '../../../shared/specialists/specialist-actions'

/** Render a specialist's Soul through main, degrading to a legible placeholder. */
export async function loadSpecialistSoul(specialistId: SpecialistActionId): Promise<string> {
  const action = getSpecialistAction(specialistId)

  try {
    const result = await window.api.readSpecialistSoul(action.id)
    return result.ok ? result.prompt : buildMissingSpecialistSoul(action, result.message)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return buildMissingSpecialistSoul(action, message)
  }
}
