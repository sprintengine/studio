import { app, safeStorage } from 'electron'
import { dirname, join } from 'path'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
}

export class GitHubTokenStore {
  private inMemoryToken: string | null = null

  private get tokenPath(): string {
    return join(app.getPath('userData'), 'github-token.bin')
  }

  async getStatus(): Promise<GitHubTokenStatus> {
    const savedToken = await this.readToken()
    const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || ''
    if (savedToken) {
      return { configured: true, source: 'settings', encryptionAvailable: safeStorage.isEncryptionAvailable() }
    }
    if (envToken) {
      return { configured: true, source: 'environment', encryptionAvailable: safeStorage.isEncryptionAvailable() }
    }
    return { configured: false, source: 'none', encryptionAvailable: safeStorage.isEncryptionAvailable() }
  }

  async resolveToken(explicitToken?: string | null): Promise<string> {
    const explicit = explicitToken?.trim()
    if (explicit) return explicit

    const saved = await this.readToken()
    if (saved) return saved

    return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || ''
  }

  async readToken(): Promise<string | null> {
    if (this.inMemoryToken) return this.inMemoryToken
    if (!safeStorage.isEncryptionAvailable()) return null

    try {
      const encrypted = await readFile(this.tokenPath)
      const token = safeStorage.decryptString(encrypted).trim()
      this.inMemoryToken = token || null
      return this.inMemoryToken
    } catch {
      return null
    }
  }

  async writeToken(token: string): Promise<GitHubTokenStatus> {
    const trimmed = token.trim()
    if (!trimmed) throw new Error('GitHub token is required.')

    this.inMemoryToken = trimmed
    if (safeStorage.isEncryptionAvailable()) {
      await mkdir(dirname(this.tokenPath), { recursive: true })
      await writeFile(this.tokenPath, safeStorage.encryptString(trimmed), { mode: 0o600 })
    }

    return this.getStatus()
  }

  async clearToken(): Promise<GitHubTokenStatus> {
    this.inMemoryToken = null
    await unlink(this.tokenPath).catch(() => {})
    return this.getStatus()
  }
}
