declare global {
  interface Window {
    api: {
      platform: string
      readdir:   (path: string) => Promise<{ name: string; isDir: boolean }[]>
      readfile:  (path: string) => Promise<string>
      writefile: (path: string, content: string) => Promise<void>
      openDir:   () => Promise<string | null>
    }
  }
}
