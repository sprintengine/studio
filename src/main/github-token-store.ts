import { dirname, join } from 'path'
import { mkdir, readFile, unlink, writeFile } from 'fs/promises'

import { studioPlatform } from '../server/platform/platform'
import type { SecretCipher } from '../server/platform/secret-cipher'

export type GitHubTokenStatus = {
  configured: boolean
  source: 'settings' | 'environment' | 'none'
  encryptionAvailable: boolean
}

export type GitHubTokenStoreOptions = {
  /** Defaults to the installed platform's data directory. */
  resolveUserDataDir?: () => string
  /** Defaults to the installed platform's cipher (Electron's `safeStorage` in the desktop). */
  cipher?: SecretCipher
}

export class GitHubTokenStore {
  private inMemoryToken: string | null = null

  constructor(private readonly options: GitHubTokenStoreOptions = {}) {}

  private get tokenPath(): string {
    return join(this.options.resolveUserDataDir?.() ?? studioPlatform().paths.dataDir(), 'github-token.bin')
  }

  private get cipher(): SecretCipher {
    return this.options.cipher ?? studioPlatform().secrets
  }

  async getStatus(): Promise<GitHubTokenStatus> {
    const savedToken = await this.readToken()
    const envToken = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || ''
    if (savedToken) {
      return { configured: true, source: 'settings', encryptionAvailable: this.cipher.available() }
    }
    if (envToken) {
      return { configured: true, source: 'environment', encryptionAvailable: this.cipher.available() }
    }
    return { configured: false, source: 'none', encryptionAvailable: this.cipher.available() }
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
    if (!this.cipher.available()) return null

    try {
      const encrypted = await readFile(this.tokenPath)
      const token = this.cipher.open(encrypted).trim()
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
    if (this.cipher.available()) {
      await mkdir(dirname(this.tokenPath), { recursive: true })
      await writeFile(this.tokenPath, this.cipher.seal(trimmed), { mode: 0o600 })
    }

    return this.getStatus()
  }

  async clearToken(): Promise<GitHubTokenStatus> {
    this.inMemoryToken = null
    await unlink(this.tokenPath).catch(() => {})
    return this.getStatus()
  }
}
