import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type AiProvider = 'anthropic' | 'claude-cli'

interface SettingsStore {
  apiKey: string
  provider: AiProvider
  setApiKey: (key: string) => void
  setProvider: (provider: AiProvider) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      apiKey: '',
      provider: 'claude-cli',
      setApiKey:   (apiKey)   => set({ apiKey }),
      setProvider: (provider) => set({ provider }),
    }),
    { name: 'free-ai-ide-settings' }
  )
)
