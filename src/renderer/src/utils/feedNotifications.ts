// The words for the feed's notices (backlog/2026-09-04-hosted-update-and-model-
// feed.md, "Notification rules"). Pure: the store hands in what it knows, this
// hands back titles and lines, and the tests hold the table.
import type { CliVersionAdvisory } from '../../../shared/electron-api'
import type { HostedModel, HostedModelFeed } from '../../../shared/hosted-model-feed'

export type Notice = {
  title: string
  description: string
}

const joinNames = (names: string[]): string => {
  if (names.length <= 1) return names.join('')
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

// One notice per fetch that introduced ids for INSTALLED CLIs: "New models for
// Claude Code" + up to three names, then "and N more". Two CLIs in one fetch
// make one notice naming both. Ids the person already added by hand are not
// news and are left out.
export function newModelsNotice(input: {
  additions: Record<string, HostedModel[]>
  installed: ReadonlySet<string>
  userModels: (cli: string) => ReadonlyArray<string>
  displayName: (cli: string) => string
}): Notice | null {
  const perCli = Object.entries(input.additions)
    .filter(([cli]) => input.installed.has(cli))
    .map(([cli, models]) => {
      const own = new Set(input.userModels(cli))
      return { cli, models: models.filter((model) => !own.has(model.id)) }
    })
    .filter((entry) => entry.models.length > 0)
  if (perCli.length === 0) return null
  const clis = joinNames(perCli.map((entry) => input.displayName(entry.cli)))
  const models = perCli.flatMap((entry) => entry.models)
  const named = models.slice(0, 3).map((model) => model.label)
  const rest = models.length - named.length
  const list = rest > 0 ? `${named.join(', ')}, and ${rest} more` : joinNames(named)
  return {
    title: models.length === 1 ? `New model for ${clis}` : `New models for ${clis}`,
    description: `${list} ${models.length === 1 ? 'is' : 'are'} in the picker.`,
  }
}

// A retired id that somebody's remembered selection still names: one warn per
// retired model, naming who used it. Retired ids nobody selected leave quietly.
export function retiredModelNotices(input: {
  previous: HostedModelFeed | null
  next: HostedModelFeed
  remembered: ReadonlyArray<{ who: string; cli: string; model: string }>
  displayName: (cli: string) => string
}): Notice[] {
  const notices: Notice[] = []
  for (const [cli, entry] of Object.entries(input.next.clis)) {
    const before = new Map((input.previous?.clis[cli]?.models ?? []).map((model) => [model.id, model]))
    for (const model of entry.models) {
      if (model.retired !== true) continue
      if (before.get(model.id)?.retired === true) continue
      const users = input.remembered.filter((r) => r.cli === cli && r.model === model.id).map((r) => r.who)
      if (users.length === 0) continue
      notices.push({
        title: `${model.label} has been retired`,
        description: `${joinNames(users)} used it. ${users.length === 1 ? 'It launches' : 'They launch'} with ${input.displayName(cli)}'s default until you pick another.`,
      })
    }
  }
  return notices
}

// The CLI-update toast's copy: "Update available: Codex 0.153.3".
export function cliUpdateNotice(advisory: CliVersionAdvisory, displayName: (cli: string) => string): Notice {
  return {
    title: `Update available: ${displayName(advisory.cli)} ${advisory.latestVersion ?? ''}`.trim(),
    description: 'Install the update now or review settings.',
  }
}

export function updateReadyNotice(appName: string, version: string | null): Notice {
  return {
    title: version ? `${appName} ${version} is ready` : `${appName} update is ready`,
    description: 'Installs the next time you quit.',
  }
}
