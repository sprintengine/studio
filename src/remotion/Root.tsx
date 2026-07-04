import { Composition, Folder } from 'remotion'
import { SprintEngineProductHero } from './SprintEngineProductHero'
import { SprintEngineOrchestration } from './orchestration/SprintEngineOrchestration'
import { FPS, TOTAL_FRAMES } from './orchestration/scenes'

export const RemotionRoot = () => {
  return (
    <Folder name="Marketing">
      <Composition
        id="SprintEngineProductHero"
        component={SprintEngineProductHero}
        durationInFrames={960}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
      <Composition
        id="SprintEngineOrchestration"
        component={SprintEngineOrchestration}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{}}
      />
    </Folder>
  )
}
