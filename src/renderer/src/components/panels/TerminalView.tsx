import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli, SwarmRole } from '../../types/workspace'
import { loadSpecialistPrompt } from '../../specialists/specialistActions'
import { buildSwarmAgentRosterForState, swarmRoleLabels } from '../../utils/swarm'
import { getSwarmStateFilePath } from '../../utils/swarmStateFile'

interface Props {
  workspaceId: string
  agentId: string
}

const SWARM_COMMAND = 'swarm'
const MAX_TERMINAL_READINESS_BUFFER = 5000

function plainTerminalText(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n')
}

function looksLikeCliReady(output: string, cli: AgentCli): boolean {
  if (cli === 'claude') {
    return /Claude Code|Welcome to Claude|cwd:|Bypassing Permissions|\/help|Try .*Claude/i.test(output)
  }

  return /Codex|OpenAI|GPT|\/help|model/i.test(output)
}

function looksLikeLaunchBlocked(output: string): boolean {
  return /unexpected EOF|command not found|No such file or directory|can't open file|WSL could not be started|Access is denied|permission denied|not recognized|CLI was not found/i.test(output)
}

function looksLikeTrustPrompt(output: string, cli: AgentCli): boolean {
  if (cli !== 'claude') return false
  return /Do you trust the files|trust files in this folder/i.test(output)
}


function buildSwarmStartupPrompt(role: SwarmRole, agentId: string, goal: string): string {
  const roleLabel = swarmRoleLabels[role]
  const firstAction = role === 'architect'
    ? `Run \`${SWARM_COMMAND} init --goal "${goal}"\` to receive your full prompt and instructions.`
    : `Run \`${SWARM_COMMAND} join --role ${role} --id ${agentId}\` to receive your full prompt and next directive.`

  return [
    `You are the ${roleLabel} specialist for this swarm run.`,
    `Agent id: ${agentId}`,
    `Goal: ${goal}`,
    `Use \`${SWARM_COMMAND}\` as the shared coordination tool. This terminal predefines it and scopes it to this team's named state file.`,
    `Do not call \`python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py\` or \`python3 scripts/swarm_tool.py\` directly; use the \`${SWARM_COMMAND}\` alias instead.`,
    'Do NOT edit swarm/state.json directly. All state updates must go through the swarm tool.',
    firstAction,
  ].join('\n\n')
}

export default function TerminalView({ workspaceId, agentId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const agent = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.agents[agentId]
  )
  const folderPath = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? undefined
  )
  const swarmName = useWorkspaceStore((s) =>
    s.workspaces.find((w) => w.id === workspaceId)?.swarmState?.name
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const cli = agent?.cli ?? 'codex'
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const startupPrompt = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    const currentAgent = workspace?.agents[agentId]
    if (currentAgent?.cliStartupPrompt) return currentAgent.cliStartupPrompt

    if (workspace?.mode !== 'swarm' || !workspace.swarmState) return null

    const role = buildSwarmAgentRosterForState(workspace.swarmState).find(
      (candidate) => candidate.id === agentId
    )?.role

    if (!role) return null
    return buildSwarmStartupPrompt(role, agentId, workspace.swarmState.goal)
  })
  const startupPromptRef = useRef<string | null>(startupPrompt)

  useEffect(() => {
    startupPromptRef.current = startupPrompt
  }, [startupPrompt])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!agent?.cliSessionId) {
      updateAgent(workspaceId, agentId, {
        cliSessionId: crypto.randomUUID(),
        cliHasLaunched: false,
      })
      return
    }

    const sessionId = agent.cliSessionId
    const shouldResume = agent.cliHasLaunched ?? false
    const term = new Terminal({
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#818cf8',
      },
      fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
    })
    const fitAddon = new FitAddon()

    const fitTerminal = () => {
      fitAddon.fit()
      if (term.cols > 0 && term.rows > 0) {
        void window.api.terminalResize(sessionId, term.cols, term.rows)
      }
    }

    const focusTerminal = () => {
      term.focus()
    }

    const copySelection = async () => {
      const selection = term.getSelection()
      if (!selection) return
      await navigator.clipboard.writeText(selection)
    }

    const pasteText = async (text: string) => {
      if (!text) return
      await window.api.terminalWrite(sessionId, text.replace(/\r?\n/g, '\r'))
      focusTerminal()
    }

    const handleCopy = (event: ClipboardEvent) => {
      const selection = term.getSelection()
      if (!selection) return
      event.preventDefault()
      event.clipboardData?.setData('text/plain', selection)
      void navigator.clipboard.writeText(selection).catch(() => {})
    }

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData('text/plain') ?? ''
      if (!text) return
      event.preventDefault()
      void pasteText(text)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey
      if (!mod) return

      const key = event.key.toLowerCase()
      if (key === 'c' && event.shiftKey) {
        event.preventDefault()
        void copySelection().catch(() => {})
      }

      if (key === 'v' && event.shiftKey) {
        event.preventDefault()
        void navigator.clipboard.readText().then(pasteText).catch(() => {})
      }
    }

    const handleContextMenu = async (event: MouseEvent) => {
      event.preventDefault()
      const hasSelection = term.hasSelection()
      const command = await window.api.showContextMenu([
        { id: 'copy', label: 'Copy', enabled: hasSelection },
        { id: 'paste', label: 'Paste' },
        { type: 'separator' },
        { id: 'select-all', label: 'Select All' },
      ])

      if (command === 'copy') {
        void copySelection().catch(() => {})
      } else if (command === 'paste') {
        void navigator.clipboard.readText().then(pasteText).catch(() => {})
      } else if (command === 'select-all') {
        term.selectAll()
      }

      focusTerminal()
    }

    term.loadAddon(fitAddon)
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        event.preventDefault()
        void window.api.terminalWrite(sessionId, '\u001b[13;2u')
        return false
      }
      return true
    })
    term.open(container)
    fitTerminal()
    focusTerminal()

    let hasInjectedStartupPrompt = false
    let promptInjectionBlocked = false
    let terminalReadinessBuffer = ''
    let promptInjectionTimer: number | null = null
    let disposed = false

    const injectStartupPrompt = () => {
      const prompt = startupPromptRef.current
      if (
        promptInjectionBlocked
        || agent.cliOnboardingPromptSent
        || !prompt
        || hasInjectedStartupPrompt
      ) return

      hasInjectedStartupPrompt = true
      updateAgent(workspaceId, agentId, {
        cliOnboardingPromptSent: true,
        cliStartupPrompt: undefined,
      })

      const normalizedPrompt = prompt.replace(/\r?\n/g, '\n')
      void window.api.terminalWrite(sessionId, `\x1b[200~${normalizedPrompt}\x1b[201~\r`)
    }

    const schedulePromptInjection = (delay: number) => {
      if (promptInjectionBlocked || agent.cliOnboardingPromptSent || hasInjectedStartupPrompt) return
      if (promptInjectionTimer !== null) return

      promptInjectionTimer = window.setTimeout(() => {
        promptInjectionTimer = null
        injectStartupPrompt()
      }, delay)
    }

    const disposeData = window.api.onTerminalData(sessionId, (data) => {
      term.write(data)
      if (data.trim().length > 0) {
        const plainData = plainTerminalText(data)
        terminalReadinessBuffer = `${terminalReadinessBuffer}${plainData}`.slice(-MAX_TERMINAL_READINESS_BUFFER)

        if (looksLikeLaunchBlocked(terminalReadinessBuffer)) {
          promptInjectionBlocked = true
          if (promptInjectionTimer !== null) {
            window.clearTimeout(promptInjectionTimer)
            promptInjectionTimer = null
          }
          return
        }

        if (looksLikeTrustPrompt(plainData, cli)) {
          if (promptInjectionTimer !== null) {
            window.clearTimeout(promptInjectionTimer)
            promptInjectionTimer = null
          }
          return
        }

        if (looksLikeCliReady(terminalReadinessBuffer, cli)) {
          schedulePromptInjection(900)
        }
      }
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
      updateAgent(workspaceId, agentId, {
        cliStartRequested: false,
        cliHasLaunched: false,
        cliOnboardingPromptSent: false,
      })
    })

    const disposeError = window.api.onTerminalError(sessionId, (message) => {
      term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
    })

    const onDataDisposable = term.onData((data) => {
      void window.api.terminalWrite(sessionId, data)
    })

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      void window.api.terminalResize(sessionId, cols, rows)
    })

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(fitTerminal)
    })
    resizeObserver.observe(container)
    container.addEventListener('mousedown', focusTerminal)
    container.addEventListener('mouseup', focusTerminal)
    container.addEventListener('click', focusTerminal)
    container.addEventListener('focus', focusTerminal)
    container.addEventListener('copy', handleCopy)
    container.addEventListener('paste', handlePaste)
    container.addEventListener('keydown', handleKeyDown)
    container.addEventListener('contextmenu', handleContextMenu)

    const ensureSpecialistStartupPrompt = async () => {
      if (startupPromptRef.current || agent.cliOnboardingPromptSent) return
      if (agent.kind !== 'specialist' || !agent.specialistId) return

      const prompt = await loadSpecialistPrompt(agent.specialistId)
      if (disposed) return

      startupPromptRef.current = prompt
      updateAgent(workspaceId, agentId, { cliStartupPrompt: prompt })
    }

    const launchTerminal = async () => {
      await ensureSpecialistStartupPrompt()
      if (disposed) return

      const swarmStatePath = folderPath && swarmName ? getSwarmStateFilePath(folderPath, swarmName) : undefined
      void window.api.terminalSpawn(
        sessionId,
        term.cols,
        term.rows,
        folderPath,
        shouldResume,
        swarmStatePath,
        cli,
        undefined,
        cliRuntimes
      )
      if (!shouldResume) {
        updateAgent(workspaceId, agentId, {
          cliHasLaunched: true,
        })
      }
    }

    void launchTerminal()
    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
      disposed = true
      if (promptInjectionTimer !== null) {
        window.clearTimeout(promptInjectionTimer)
      }
      window.clearTimeout(settleTimer)
      resizeObserver.disconnect()
      container.removeEventListener('mousedown', focusTerminal)
      container.removeEventListener('mouseup', focusTerminal)
      container.removeEventListener('click', focusTerminal)
      container.removeEventListener('focus', focusTerminal)
      container.removeEventListener('copy', handleCopy)
      container.removeEventListener('paste', handlePaste)
      container.removeEventListener('keydown', handleKeyDown)
      container.removeEventListener('contextmenu', handleContextMenu)
      disposeData()
      disposeExit()
      disposeError()
      onDataDisposable.dispose()
      onResizeDisposable.dispose()
      term.dispose()
    }
  }, [
    workspaceId,
    agentId,
    agent?.cliSessionId,
    agent?.cliRestartNonce,
    agent?.kind,
    agent?.specialistId,
    cli,
    cliRuntimes,
    folderPath,
    swarmName,
    updateAgent,
  ])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className="absolute inset-0 overflow-hidden px-2 pb-2 cursor-text"
    />
  )
}
