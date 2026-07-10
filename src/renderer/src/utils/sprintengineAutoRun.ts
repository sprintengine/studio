/**
 * Renderer shim over the shared Sprint Engine auto-run planner.
 *
 * The implementations relocated to `src/shared/sprintengine/auto-run.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner), following the established shim pattern
 * (`sprintengineAutomationLifecycle.ts`). Existing renderer import sites and
 * tests keep working unchanged — including `sprintengineAutoRunPlanner.ts`,
 * which re-exports from this module. The shared module's perf-log seam is
 * injected here at module load, so renderer perf diagnostics behave exactly
 * as before the move.
 */
import { logPerfEvent } from './perfDiagnostics'
import { setSprintEngineAutoRunPerfLogger } from '../../../shared/sprintengine/auto-run'

setSprintEngineAutoRunPerfLogger(logPerfEvent)

export * from '../../../shared/sprintengine/auto-run'
