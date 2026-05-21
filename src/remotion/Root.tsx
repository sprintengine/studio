import { Composition } from 'remotion'
import { SprintEngineProductHero } from './SprintEngineProductHero'

export const RemotionRoot = () => {
  return (
    <Composition
      id="SprintEngineProductHero"
      component={SprintEngineProductHero}
      durationInFrames={1050}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={{}}
    />
  )
}

