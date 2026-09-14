import { execFile } from 'child_process'
import { join } from 'path'
import { lstat, mkdir, rm } from 'fs/promises'
import { promisify } from 'util'
import type { GitHubCloneInput, GitHubCloneResult } from '../shared/electron-api'
import { validateCloneUrl } from '../shared/git-clone-url'

const execFileAsync = promisify(execFile)

// A clone is minutes, not seconds, but never forever: a wedged transport must
// release the create button eventually (there is no cancel affordance in v1).
const CLONE_TIMEOUT_MS = 15 * 60 * 1000

// The token travels to git through the child's environment and an inline
// credential helper — never through argv (visible in `ps`) and never into the
// cloned repo's config (the remote URL stays clean). The helper reads the
// host git is asking about from stdin and answers ONLY for github.com, so a
// cross-host redirect mid-clone gets nothing rather than the token.
const TOKEN_ENV_VAR = 'SPRINTENGINE_GITHUB_CLONE_TOKEN'
const TOKEN_CREDENTIAL_HELPER =
  '!f() { h=; while IFS= read -r l; do [ "$l" = "host=github.com" ] && h=1; [ -z "$l" ] && break; done; '
  + `[ "$h" = "1" ] && printf "username=x-access-token\\npassword=%s\\n" "$${TOKEN_ENV_VAR}"; :; }; f`

// lstat, not stat: a dangling symlink at the target is still an occupied
// path — git would refuse it, so the pre-check must see it too.
async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Clone a repository into parentDir/folderName for the new-workspace flow.
 * Never throws — failures return `{ok:false}` with a user-facing message so
 * the hub can surface them in the folder field's error slot.
 */
export async function cloneGitHubRepo(
  input: GitHubCloneInput & { token?: string | null },
): Promise<GitHubCloneResult> {
  const urlCheck = validateCloneUrl(input.url)
  if (!urlCheck.ok) return { ok: false, message: urlCheck.error }

  const folderName = input.folderName.trim()
  if (!folderName || folderName === '.' || folderName === '..' || /[/\\]/.test(folderName)) {
    return { ok: false, message: 'Enter a valid folder name for the clone.' }
  }
  const target = join(input.parentDir, folderName)
  if (await pathExists(target)) {
    return { ok: false, message: 'That folder already exists — choose a new location to clone into.' }
  }

  try {
    await mkdir(input.parentDir, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not create the parent folder.',
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    // Fail fast instead of hanging on an interactive host-key or passphrase
    // prompt no one can see. An agent-backed ssh clone still works.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -oBatchMode=yes',
  }
  const args = ['clone']
  // Inject the stored token only toward github.com over https: any other host
  // must never see it, and ssh clones authenticate with the user's own keys.
  const token = input.token?.trim()
  if (token && urlCheck.httpsHost === 'github.com') {
    env[TOKEN_ENV_VAR] = token
    // The empty helper first: it clears inherited helpers (osxkeychain,
    // manager) so a stale stored credential cannot shadow the token.
    args.unshift('-c', 'credential.helper=', '-c', `credential.helper=${TOKEN_CREDENTIAL_HELPER}`)
  }
  args.push('--', urlCheck.url, target)

  try {
    await execFileAsync('git', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      timeout: CLONE_TIMEOUT_MS,
      env,
    })
    return { ok: true, path: target }
  } catch (error) {
    const execError = error as { stderr?: string; killed?: boolean; message?: string }
    if (execError.killed) {
      // git cleans up its own failed targets; only a kill (timeout/maxBuffer)
      // can strand a partial directory, and only then is removal justified —
      // an unconditional rm could TOCTOU-delete a folder something else
      // created at this path between the pre-check and the failure.
      await rm(target, { recursive: true, force: true }).catch(() => {})
      return {
        ok: false,
        message: (execError.message ?? '').includes('maxBuffer')
          ? 'The clone produced too much output and was stopped.'
          : 'The clone timed out. Check the URL and your connection, then try again.',
      }
    }
    const stderr = (execError.stderr ?? '').trim()
    const tail = stderr
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('Cloning into'))
      .slice(-3)
      .join(' ')
    return { ok: false, message: tail || execError.message || 'git clone failed.' }
  }
}
