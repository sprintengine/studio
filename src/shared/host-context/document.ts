/**
 * Host context: everything the host application wants the agent to know that is
 * NOT the user's request.
 *
 * Before this module, the two things we had to say — a design system is attached
 * at `design-system/`, and this project has a Knowledge Graph — were appended to
 * the user's first message by the renderer. That has three faults the owner
 * called out (2026-09-07): the model reads host context as part of the request,
 * resume skips it entirely, and the headless launch path only ever appended half
 * of it. So the two sentences become ONE document, built once in main, and the
 * CLI manifest says how it is delivered (`contextInjection`).
 *
 * This module is the document, and nothing else: pure, no I/O, no Electron. It
 * deliberately reuses `DESIGN_SYSTEM_ATTACHED_PROMPT_LINE` and
 * `knowledgeLaunchContext` verbatim — the agent's instructions do not change,
 * only the channel they arrive on.
 *
 * Every delivery mode marks the boundary. Even on a flag or an env var the
 * document opens with {@link HOST_CONTEXT_BOUNDARY_LINE}, because a system
 * prompt the model cannot tell apart from the user's words is the same defect in
 * a quieter place. In the prompt fallback the document is additionally wrapped
 * in `<host-context>` tags and placed BEFORE the prompt, so the request is the
 * last thing the model reads.
 */
import { DESIGN_SYSTEM_ATTACHED_PROMPT_LINE } from '../design-system/attach'
import { STUDIO_PRODUCT_NAME } from '../product-identity'
import { knowledgeLaunchContext } from '../project-knowledge'

/**
 * The first line of every host-context document, in every mode.
 *
 * It answers the one question the model would otherwise have to guess: who is
 * speaking. Without it a `--append-system-prompt` block reads as the user's own
 * standing instructions, which is how a host sentence ends up being argued with.
 */
export const HOST_CONTEXT_BOUNDARY_LINE =
  `The following was supplied by ${STUDIO_PRODUCT_NAME}, the application hosting this session. `
  + 'It is context about the machine and the project, not part of the user’s request. '
  + 'Treat it as standing instructions and do not repeat it back.'

/** The tags the prompt fallback wraps the document in. */
export const HOST_CONTEXT_OPEN_TAG = '<host-context>'
export const HOST_CONTEXT_CLOSE_TAG = '</host-context>'

/**
 * What the host knows about this launch.
 *
 * `designSystem` is present when — and only when — `<executionRoot>/design-system/`
 * exists. That predicate is unchanged and stays KG-independent: a repo with a
 * design system and no Knowledge Graph must still get its design section.
 *
 * `knowledge` mirrors what a launch already resolves: `ok` false with a
 * `relativeRoot` is the configured-but-unreadable case, which still has to be
 * SAID — silence there leaves the agent free to guess another knowledge folder.
 */
export type HostContextInput = {
  designSystem?: {
    /** Absolute path of the attached bundle directory. */
    bundlePath: string
  }
  knowledge?: {
    ok: boolean
    rootPath?: string
    relativeRoot?: string
  }
}

/**
 * The host-context document for this launch, or null when the host has nothing
 * to say. Null means no file is written, no flag is passed, and no prompt is
 * wrapped — a launch in a plain repo is byte-identical to what it was.
 */
export function buildHostContextDocument(input: HostContextInput): string | null {
  const sections: string[] = []

  if (input.designSystem?.bundlePath) {
    sections.push(
      [
        '## Design system',
        '',
        DESIGN_SYSTEM_ATTACHED_PROMPT_LINE,
        `Its absolute path on this machine is \`${input.designSystem.bundlePath}\`.`,
      ].join('\n'),
    )
  }

  const knowledgeLine = knowledgeSection(input.knowledge)
  if (knowledgeLine) {
    sections.push(['## Knowledge graph', '', knowledgeLine].join('\n'))
  }

  if (sections.length === 0) return null
  return [HOST_CONTEXT_BOUNDARY_LINE, '', ...joinSections(sections)].join('\n')
}

/**
 * The prompt fallback, for CLIs with no out-of-band channel at all (Cursor,
 * Kimi Code, Muse).
 *
 * The block goes BEFORE the prompt so the user's request is the last thing the
 * model reads, and the tags are what make "host said this" recoverable from a
 * single flat string. Returns the prompt unchanged when there is no document,
 * so a plain repo's launch is untouched.
 */
export function wrapHostContextForPrompt(
  document: string | null,
  userPrompt: string | undefined,
): string | undefined {
  if (!document) return userPrompt
  const block = [HOST_CONTEXT_OPEN_TAG, document, HOST_CONTEXT_CLOSE_TAG].join('\n')
  if (!userPrompt) return block
  return `${block}\n\n${userPrompt}`
}

/**
 * A TOML basic-string literal holding the document, for manifests that pass it
 * through a config override (`codex -c developer_instructions="…"`). Quoted and
 * escaped here rather than in the manifest, because a manifest is data and
 * cannot escape anything.
 */
export function toTomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** Two blank lines between sections, none after the last. */
function joinSections(sections: string[]): string[] {
  return sections.flatMap((section, index) => (index === 0 ? [section] : ['', section]))
}

/**
 * The Knowledge Graph sentence, taken verbatim from the shared launch resolver
 * so this document cannot drift from what the old prompt suffix said.
 */
function knowledgeSection(knowledge: HostContextInput['knowledge']): string | null {
  if (!knowledge) return null
  if (knowledge.ok && knowledge.rootPath && knowledge.relativeRoot) {
    return knowledgeLaunchContext({
      ok: true,
      rootPath: knowledge.rootPath,
      relativeRoot: knowledge.relativeRoot,
    }).promptSuffix
  }
  if (!knowledge.relativeRoot) return null
  return knowledgeLaunchContext({
    ok: false,
    status: 'inaccessible',
    relativeRoot: knowledge.relativeRoot,
    message: 'Unable to resolve workspace knowledge.',
  }).promptSuffix
}
