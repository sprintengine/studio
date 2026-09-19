// Part of the IPC contract: importing configuration from another agent CLI.
// ../electron-api.ts re-exports everything here.

import type { McpClientTarget, McpTransport } from './agent-runtime'

/**
 * The two CLIs the first-run import wizard scans for existing config. A closed
 * pair, not a list of every CLI: the paths it scans are the *user-level* ones
 * (`~/.codex/config.toml`, `~/.claude.json`), which no plugin manifest declares
 * — manifests declare the workspace paths the writer owns.
 *
 * The parsers behind it are already shared with the manifest-driven read path
 * (src/main/mcp-config-readers), so there is one parser per format. What is
 * still literal here is the path list; widening the wizard to every CLI means
 * declaring those user-level paths in the manifests and resolving them through
 * `resolveMcpConfigPath`, which is the read path's job, not another
 * hardcoded pair here.
 */
export type AgentConfigImportSource = 'codex' | 'claude-code'

export type AgentConfigDetectedMcpServer = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  transport: McpTransport
  enabled: boolean
  envVarNames: string[]
  hasSecretValues: boolean
}

export type AgentConfigDetectedSkill = {
  key: string
  id: string
  name: string
  source: AgentConfigImportSource
  sourceLabel: string
  adoptable: boolean
}

export type AgentConfigDetectInput = {
  sources?: AgentConfigImportSource[]
}

export type AgentConfigDetectResult =
  | {
      ok: true
      mcpServers: AgentConfigDetectedMcpServer[]
      skills: AgentConfigDetectedSkill[]
      warnings: string[]
    }
  | { ok: false; message: string; warnings?: string[] }

export type AgentConfigAdoptInput = {
  workspaceRoot: string
  mcpServerKeys?: string[]
  skillKeys?: string[]
}

export type AgentConfigAdoptedMcpServer = {
  id: string
  clients: McpClientTarget[]
}

export type AgentConfigAdoptedSkill = {
  id: string
  status: 'installed' | 'updated'
}

export type AgentConfigAdoptResult =
  | {
      ok: true
      adoptedMcpServers: AgentConfigAdoptedMcpServer[]
      adoptedSkills: AgentConfigAdoptedSkill[]
      warnings: string[]
    }
  | {
      ok: false
      message: string
      adoptedMcpServers?: AgentConfigAdoptedMcpServer[]
      adoptedSkills?: AgentConfigAdoptedSkill[]
      warnings?: string[]
    }
