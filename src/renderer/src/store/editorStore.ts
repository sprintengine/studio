import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { immer } from 'zustand/middleware/immer'

export type OpenFile = {
  path: string
  name: string
  content: string
  language: string
  isDirty: boolean
}

interface EditorStore {
  rootPath: string | null
  openFiles: OpenFile[]
  activeFilePath: string | null
  setRootPath: (path: string) => void
  openFile: (path: string, name: string, content: string) => void
  closeFile: (path: string) => void
  setActiveFile: (path: string) => void
  updateContent: (path: string, content: string) => void
  markClean: (path: string) => void
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', rb: 'ruby', php: 'php',
    html: 'html', css: 'css', scss: 'scss', json: 'json',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sh: 'shell', bash: 'shell', sql: 'sql', xml: 'xml',
  }
  return map[ext] ?? 'plaintext'
}

export const useEditorStore = create<EditorStore>()(
  persist(
    immer((set) => ({
      rootPath: null,
      openFiles: [],
      activeFilePath: null,

      setRootPath: (path) => set((s) => { s.rootPath = path }),

      openFile: (path, name, content) =>
        set((s) => {
          const existing = s.openFiles.find((f) => f.path === path)
          if (!existing) {
            s.openFiles.push({ path, name, content, language: detectLanguage(name), isDirty: false })
          }
          s.activeFilePath = path
        }),

      closeFile: (path) =>
        set((s) => {
          const idx = s.openFiles.findIndex((f) => f.path === path)
          if (idx === -1) return
          s.openFiles.splice(idx, 1)
          if (s.activeFilePath === path) {
            s.activeFilePath = s.openFiles.at(-1)?.path ?? null
          }
        }),

      setActiveFile: (path) => set((s) => { s.activeFilePath = path }),

      updateContent: (path, content) =>
        set((s) => {
          const f = s.openFiles.find((f) => f.path === path)
          if (f) { f.content = content; f.isDirty = true }
        }),

      markClean: (path) =>
        set((s) => {
          const f = s.openFiles.find((f) => f.path === path)
          if (f) f.isDirty = false
        }),
    })),
    {
      name: 'free-ai-ide-editor',
      // Don't persist file content — only rootPath and tab list (without content)
      partialize: (s) => ({
        rootPath: s.rootPath,
        openFiles: s.openFiles.map((f) => ({ ...f, content: '' })),
        activeFilePath: s.activeFilePath,
      }),
    }
  )
)
