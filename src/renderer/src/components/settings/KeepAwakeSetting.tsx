import { MainOwnedSettingToggle } from './MainOwnedSettingToggle'

// Settings → General: "Keep the computer awake while agents work". Main owns
// the value, because main holds the power-save blocker as agents start and
// stop (agent-keep-awake.ts). A browser tab, whose machine is not this one,
// shows nothing.
export function KeepAwakeSetting() {
  return (
    <MainOwnedSettingToggle
      label="Keep the computer awake while agents work"
      description="The computer does not go to sleep while an agent is mid-turn. The display can still turn off and lock."
      read={window.api?.getKeepAwake}
      write={(enabled) => window.api.setKeepAwake(enabled)}
    />
  )
}
