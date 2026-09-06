import { RunDoorSurface } from './RunDoorSurface'
import { SPRINTS_DOOR } from './runDoorCopy'

// The Sprints door (item 1763, two doors since item 2470).
//
// Everything this surface is lives in `RunDoorSurface`, which Workflows is too:
// the two doors differ only in which runs they list and what they call them, and
// a second copy of the surface is exactly the drift the door substrate exists to
// stop. What remains here is the door's identity — the definition it is mounted
// with — so `registerGlobalSurface('sprints')` still resolves to a component of
// its own and the module registry keeps naming one door per entry.
export default function SprintsGlobalSurface(): JSX.Element {
  return <RunDoorSurface door={SPRINTS_DOOR} />
}
