import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { SwarmRole } from '../../types/workspace'
import { buildSwarmAgentRoster, swarmRoleLabels } from '../../utils/swarm'
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

function looksLikeClaudeReady(output: string): boolean {
  return /Claude Code|Welcome to Claude|cwd:|Bypassing Permissions|\/help|Try .*Claude/i.test(output)
}

function looksLikeLaunchBlocked(output: string): boolean {
  return /unexpected EOF|command not found|No such file or directory|can't open file|WSL could not be started/i.test(output)
}

function looksLikeClaudeTrustPrompt(output: string): boolean {
  return /Do you trust the files|trust files in this folder/i.test(output)
}

function buildWorkerExecutionPrompt(role: SwarmRole, agentId: string): string {
  return [
    'The architect plan is approved. Begin worker execution now.',
    `First run \`${SWARM_COMMAND} get-mailbox --agent-id ${agentId} --consume\` to read any direct instructions from the architect or other specialists.`,
    `Run \`${SWARM_COMMAND} claim-next-task --role ${role} --agent-id ${agentId}\` to atomically claim your next ready task.`,
    'If a task is returned, read swarm/plan.md and the returned task JSON before editing. Implement only your claimed task and stay within the task intent and owned paths unless the work clearly requires a better specialist judgment.',
    `Run the relevant tests, lint, or typecheck for your change. If you need user input, run \`${SWARM_COMMAND} set-task-status --task-id <task-id> --status needs_input --actor ${agentId}\` and make the question clear with \`${SWARM_COMMAND} add-note\`.`,
    `Before marking the task done, run \`${SWARM_COMMAND} append-evidence --task-id <task-id> --actor ${agentId}\` with your summary, touched files, commands, and results. Then run \`${SWARM_COMMAND} set-task-status --task-id <task-id> --status done --actor ${agentId}\`.`,
    `While active, poll your mailbox about every 30 seconds with \`${SWARM_COMMAND} get-mailbox --agent-id ${agentId} --consume\` so you receive architect updates and cross-specialist messages.`,
    `After finishing, run \`${SWARM_COMMAND} claim-next-task --role ${role} --agent-id ${agentId}\` again. If no ready task is available, stay idle and do not edit shared swarm state manually.`,
  ].join('\n\n')
}

function buildProductPlanningPrompt(agentId: string, goal: string, planApproved: boolean): string {
  if (planApproved) {
    return [
      'The plan is approved. Continue as the product strategist for this swarm.',
      `First run \`${SWARM_COMMAND} get-mailbox --agent-id ${agentId} --consume\` to read any direct instructions.`,
      `Run \`${SWARM_COMMAND} claim-next-task --role product --agent-id ${agentId}\` if there are approved product review, market research, or adoption-risk tasks ready for you.`,
    'When you contribute, focus on competitor products, target audience needs, workflow fit, positioning, onboarding clarity, trust, and whether the implementation still serves the intended user.',
    `While active, poll your mailbox about every 30 seconds with \`${SWARM_COMMAND} get-mailbox --agent-id ${agentId} --consume\`.`,
    `If a mailbox message asks you to reply and includes a reply command or request id, answer with \`${SWARM_COMMAND} send-message --from-agent ${agentId} --to-agent <sender> --subject "Re: <subject>" --body "<response>" --reply-to <request-id>\`.`,
    'Publish findings through task notes, consultation responses, mailbox replies, or task evidence. Do not manually edit shared swarm state.',
    ].join('\n\n')
  }

  return [
    'You are the product strategist for this swarm. Your job is to sharpen what the team should build before implementation starts.',
    `Goal: ${goal}`,
    'When the architect asks for consultation, research the likely market, competitor products, audience demographics, workflows, adoption risks, and product positioning.',
    'Give concrete guidance that can change scope, priority, language, interaction design, or acceptance criteria. Prefer practical tradeoffs over broad product theory.',
    `Poll your mailbox about every 30 seconds with \`${SWARM_COMMAND} get-mailbox --agent-id ${agentId} --consume\` while you are waiting for architect consultation.`,
    `When replying to a mailbox request, use \`${SWARM_COMMAND} send-message --from-agent ${agentId} --to-agent <sender> --subject "Re: <subject>" --body "<response>" --reply-to <request-id>\` so the sender can continue automatically.`,
    'Use `swarm complete-consultation` for consultation responses and do not manually edit shared swarm state.',
  ].join('\n\n')
}

function buildSwarmStartupPrompt(
  role: SwarmRole,
  agentId: string,
  goal: string,
  planApproved: boolean,
  customRolePrompt: string | undefined
): string {
  const roleLabel = swarmRoleLabels[role]
  const rolePrompt = customRolePrompt?.trim()
  const firstAction =
    role === 'architect'
      ? planApproved
        ? 'The plan is already approved. Stay aligned with swarm/plan.md and use the coordination tool only for consultations or state updates that belong to the architect.'
        : [
            'You are responsible for creating the plan from scratch. Treat swarm/plan.md as your final planning artifact, not as an existing source of truth.',
            'First, carefully study the repository and current implementation. Inspect the relevant code, architecture, conventions, dependencies, and any existing related features.',
            'Perform deep problem/domain research using the available local context and specialist consultations when helpful. For market, competitor, audience, positioning, workflow, or adoption-risk concerns, consult the product strategist early instead of guessing.',
            'For UI/UX, security, testing, or implementation concerns, create structured consultation requests with the swarm tool instead of guessing.',
            'When you need product validation before continuing, use: `swarm send-and-receive --from-agent architect --to-agent product --subject "Product validation request" --body "<your question>" --timeout-seconds 1800 --consume`. This sends the request and blocks until the product strategist replies with the matching `--reply-to` id.',
            'Ask the user clarifying questions until you are fully aligned on the desired outcome, constraints, scope, and acceptance criteria. Do not finalize the plan until the user confirms the direction.',
            'Only after alignment, write swarm/plan.md as a compact technical execution plan for AI agents. Keep it succinct, low-level, and directly actionable.',
            'Plan format: Goal, Constraints, Technical Approach, Files/Surfaces, Task Graph Summary, Acceptance Checks, Risks/Open Questions. Use short bullets. Do not write narrative prose, market decks, roadmap language, or implementation timelines.',
            'Do not include weeks, dates, sprint plans, milestone schedules, duration estimates, or sequencing expressed as time. AI specialists execute in seconds or minutes; represent ordering only with task dependencies in swarm/tasks.json.',
            'Keep swarm/plan.md focused on context workers need that is not already encoded in tasks.json. The task graph is the primary execution contract, so prefer precise task titles, owned paths, dependencies, acceptance criteria, and implementation notes over a long plan document.',
            'Create swarm/tasks.json using swarm/tasks.template.json and swarm/tasks.schema.json as the contract. Run `swarm validate-tasks --file swarm/tasks.json`, fix any errors, then run `swarm replace-tasks --actor architect --file swarm/tasks.json`.',
            'When the final plan is ready, send direct mailbox messages with `swarm send-message --from-agent architect --to-agent <agent-id> --subject "<subject>" --body "<body>"` or `swarm broadcast-message --from-agent architect --subject "<subject>" --body "<body>"` so each specialist knows when and how to proceed.',
            'After the final plan and board task graph are ready, run `swarm mark-plan-ready --actor architect`. Tell the user the plan is ready for review only after that succeeds. Do not manually edit shared swarm state.',
          ].join('\n\n')
      : role === 'product'
        ? buildProductPlanningPrompt(agentId, goal, planApproved)
      : planApproved
        ? buildWorkerExecutionPrompt(role, agentId)
        : `Do not claim work yet. Your agent id is ${agentId}. Wait for the architect to finish discovery, user alignment, swarm/plan.md, and plan approval before starting execution.`

  return [
    `You are the ${roleLabel} specialist for this swarm run.`,
    `Agent id: ${agentId}`,
    `Goal: ${goal}`,
    rolePrompt ? `Role prompt:\n${rolePrompt}` : null,
    `Use \`${SWARM_COMMAND}\` as the shared coordination tool. This terminal predefines it and scopes it to this team's named state file.`,
    `Do not call \`python3 .agents/skills/swarm-kanban/scripts/swarm_tool.py\`, \`python3 scripts/swarm_tool.py\`, or pass \`--team\`; this project may not contain those files and the state path is already configured.`,
    `Use \`type ${SWARM_COMMAND}\` to inspect the command if needed. Do not use \`which ${SWARM_COMMAND}\` because it may be a shell function.`,
    'Mailbox syntax is strict: `swarm send-message --from-agent <sender-id> --to-agent <recipient-agent-id> --subject "<subject>" --body "<body>"`. For blocking requests use `swarm send-and-receive --from-agent <sender-id> --to-agent <recipient-agent-id> --subject "<subject>" --body "<body>" --timeout-seconds 1800 --consume`. Replies must use `--reply-to <request-id>`. There is no `--recipient`, `--message`, or `--team` flag.',
    firstAction,
  ].filter(Boolean).join('\n\n')
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
  const updateAgent = useWorkspaceStore((s) => s.updateAgent)
  const swarmRole = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    if (workspace?.mode !== 'swarm' || !workspace.swarmState) return null

    return buildSwarmAgentRoster(workspace.swarmState.roleCounts).find(
      (candidate) => candidate.id === agentId
    )?.role ?? null
  })
  const swarmPlanApproved = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    return workspace?.mode === 'swarm' ? workspace.swarmState?.planApproved ?? false : false
  })
  const swarmStartupPrompt = useWorkspaceStore((s) => {
    const workspace = s.workspaces.find((w) => w.id === workspaceId)
    if (workspace?.mode !== 'swarm' || !workspace.swarmState) return null

    const role = buildSwarmAgentRoster(workspace.swarmState.roleCounts).find(
      (candidate) => candidate.id === agentId
    )?.role

    if (!role) return null
    return buildSwarmStartupPrompt(
      role,
      agentId,
      workspace.swarmState.goal,
      workspace.swarmState.planApproved,
      workspace.swarmState.rolePrompts[role]
    )
  })
  const swarmStartupPromptRef = useRef<string | null>(swarmStartupPrompt)
  const previousPlanApprovedRef = useRef<boolean | null>(swarmPlanApproved)

  useEffect(() => {
    swarmStartupPromptRef.current = swarmStartupPrompt
  }, [swarmStartupPrompt])

  useEffect(() => {
    const previous = previousPlanApprovedRef.current
    previousPlanApprovedRef.current = swarmPlanApproved

    if (
      previous !== false
      || !swarmPlanApproved
      || !agent?.cliSessionId
      || !agent.cliHasLaunched
      || agent.cliPlanApprovedPromptSent
      || !swarmRole
      || swarmRole === 'architect'
    ) {
      return
    }

    const notification = [
      '',
      '[Swarm] Plan approved. Worker execution may begin.',
      swarmRole === 'product'
        ? buildProductPlanningPrompt(agentId, 'Approved swarm plan', true)
        : buildWorkerExecutionPrompt(swarmRole, agentId),
      '',
    ].join('\n')

    updateAgent(workspaceId, agentId, { cliPlanApprovedPromptSent: true })
    void window.api.terminalWrite(agent.cliSessionId, notification.replace(/\r?\n/g, '\r'))
  }, [
    agent?.cliHasLaunched,
    agent?.cliPlanApprovedPromptSent,
    agent?.cliSessionId,
    agentId,
    swarmPlanApproved,
    swarmRole,
    updateAgent,
    workspaceId,
  ])

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

    let hasInjectedSwarmPrompt = false
    let promptInjectionBlocked = false
    let terminalReadinessBuffer = ''
    let promptInjectionTimer: number | null = null

    const injectSwarmPrompt = () => {
      const prompt = swarmStartupPromptRef.current
      if (
        promptInjectionBlocked
        || agent.cliOnboardingPromptSent
        || !prompt
        || hasInjectedSwarmPrompt
      ) return

      hasInjectedSwarmPrompt = true
      updateAgent(workspaceId, agentId, { cliOnboardingPromptSent: true })

      const normalizedPrompt = prompt.replace(/\r?\n/g, '\n')
      void window.api.terminalWrite(sessionId, `\x1b[200~${normalizedPrompt}\x1b[201~\r`)
    }

    const schedulePromptInjection = (delay: number) => {
      if (promptInjectionBlocked || agent.cliOnboardingPromptSent || hasInjectedSwarmPrompt) return
      if (promptInjectionTimer !== null) return

      promptInjectionTimer = window.setTimeout(() => {
        promptInjectionTimer = null
        injectSwarmPrompt()
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

        if (looksLikeClaudeTrustPrompt(plainData)) {
          if (promptInjectionTimer !== null) {
            window.clearTimeout(promptInjectionTimer)
            promptInjectionTimer = null
          }
          return
        }

        if (looksLikeClaudeReady(terminalReadinessBuffer)) {
          schedulePromptInjection(900)
        }
      }
    })

    const disposeExit = window.api.onTerminalExit(sessionId, (code) => {
      term.write(`\r\n\x1b[31m[Terminal exited with code ${code}]\x1b[0m\r\n`)
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

    const swarmStatePath = folderPath && swarmName ? getSwarmStateFilePath(folderPath, swarmName) : undefined
    void window.api.terminalSpawn(
      sessionId,
      term.cols,
      term.rows,
      folderPath,
      shouldResume,
      swarmStatePath
    )
    if (!shouldResume) {
      updateAgent(workspaceId, agentId, {
        cliHasLaunched: true,
      })
    }
    if (swarmStartupPromptRef.current && !agent.cliOnboardingPromptSent) {
      schedulePromptInjection(shouldResume ? 6500 : 5000)
    }

    const settleTimer = window.setTimeout(() => {
      fitTerminal()
      focusTerminal()
    }, 50)

    return () => {
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
      void window.api.terminalKill(sessionId).catch(() => {})
      term.dispose()
    }
  }, [
    workspaceId,
    agentId,
    agent?.cliSessionId,
    agent?.cliRestartNonce,
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
