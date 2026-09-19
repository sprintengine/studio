// Part of the IPC contract: conversation providers and the secrets they and other credentials use.
// ../electron-api.ts re-exports everything here.

import type { ConversationProviderListEntry, ConversationProviderModel } from '../plugin-manifest'

export type ConversationProviderListResult =
  { ok: true; providers: ConversationProviderListEntry[] } | { ok: false; message: string }

export type ConversationProviderModelsInput = {
  providerId: string
}

export type ConversationProviderModelsResult =
  { ok: true; models: ConversationProviderModel[] } | { ok: false; message: string }

export type ConversationSecretStatus = {
  providerId: string
  configured: boolean
  source: 'settings' | 'session' | 'environment' | 'none'
  persistence: 'encrypted' | 'session' | 'environment'
  encryptionAvailable: boolean
  label: string
}

export type ConversationSecretStatusInput = {
  providerId: string
}

export type ConversationSecretSetInput = ConversationSecretStatusInput & {
  value: string
}

export type ConversationSecretClearInput = ConversationSecretStatusInput

export type ConversationSecretStatusResult =
  { ok: true; status: ConversationSecretStatus } | { ok: false; message: string }

export type ConversationSecretSetResult = ConversationSecretStatusResult

export type ConversationSecretClearResult = ConversationSecretStatusResult

// Generic credential IPC — the shared credential store surfaced for any owner
// kind (CLI plugins AND conversation providers). `id` is the manifest id whose
// `auth` descriptor owns the secret. Results reuse the conversation-secret
// shapes, which are structurally generic.
export type CredentialSecretStatusInput = {
  id: string
}

export type CredentialSecretSetInput = CredentialSecretStatusInput & {
  value: string
}

export type CredentialSecretClearInput = CredentialSecretStatusInput

export type CredentialSecretStatusResult = ConversationSecretStatusResult

export type CredentialSecretSetResult = ConversationSecretSetResult

export type CredentialSecretClearResult = ConversationSecretClearResult

// Runtime CLI identity is a plugin id. Bundled choices include `codex` and
// `claude-code`.
export type AgentCli = string
