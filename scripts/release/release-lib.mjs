// The pure half of the release workflow: version arithmetic, the macOS
// updater-manifest merge, the manifest checks and the release body. Everything
// that talks to GitHub lives in release.mjs; everything here is tested by
// release-lib.test.mjs without a network.

import { createRequire } from 'node:module'

// js-yaml comes through electron-updater, a direct dependency that parses these
// same manifests inside the shipped app, so the writer here and the reader in
// the app are the same library. Loaded lazily: `release.mjs resolve` runs
// before `npm ci` and never touches YAML.
let yamlModule = null
function yaml() {
  if (!yamlModule) {
    const require = createRequire(import.meta.url)
    yamlModule = createRequire(require.resolve('electron-updater/package.json'))('js-yaml')
  }
  return yamlModule
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

export function parseVersion(raw) {
  const match = VERSION_RE.exec(String(raw).replace(/^v/, ''))
  if (!match) throw new Error(`Not a release version: ${raw}`)
  const [, major, minor, patch, pre] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch), pre: pre ?? null }
}

export function coreVersion(raw) {
  const { major, minor, patch } = parseVersion(raw)
  return `${major}.${minor}.${patch}`
}

export function compareCore(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

// The updater channel a version belongs to, and so the name electron-builder
// gives its manifests (`latest.yml` / `preview.yml`, see publish.channel).
// update-service.ts calls any version with a prerelease part a preview build
// and pins autoUpdater.channel to 'preview'; electron-updater then only follows
// releases whose tag's FIRST prerelease identifier is `preview`. A tag like
// v1.2.0-beta.1 would be a release no installed preview build could ever see,
// so it is refused here rather than published.
export function channelForVersion(raw) {
  const { pre } = parseVersion(raw)
  if (pre === null) return 'latest'
  if (pre === 'preview' || pre.startsWith('preview.')) return 'preview'
  throw new Error(
    `Prerelease ${raw} is not a preview version. Installed preview builds only follow ` +
      `tags shaped vX.Y.Z-preview.N, so this release would reach nobody.`,
  )
}

// The version a preview previews. When package.json already names a version
// newer than anything shipped, that is the release being prepared and previews
// carry it. Otherwise the next patch after the latest stable, so a preview
// always sorts above the stable its users came from.
export function resolvePreviewBase(packageVersion, latestStable) {
  const pkg = coreVersion(packageVersion)
  if (!latestStable || compareCore(pkg, latestStable) > 0) return pkg
  const { major, minor, patch } = parseVersion(latestStable)
  return `${major}.${minor}.${patch + 1}`
}

// Numeric prerelease identifiers compare numerically in semver, so date then run
// number orders every preview, including two on the same day.
export function previewVersion(base, date, runNumber) {
  if (!/^\d{8}$/.test(date)) throw new Error(`Preview date must be YYYYMMDD, got ${date}`)
  if (!Number.isInteger(Number(runNumber)) || Number(runNumber) < 1) {
    throw new Error(`Run number must be a positive integer, got ${runNumber}`)
  }
  return `${coreVersion(base)}-preview.${date}.${Number(runNumber)}`
}

export function utcDateStamp(isoTimestamp) {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) throw new Error(`Not a timestamp: ${isoTimestamp}`)
  return date.toISOString().slice(0, 10).replaceAll('-', '')
}

// The released commit is recorded in the release body, because the releases
// live in a different repository from the source and their tags point at
// nothing in it. The preview gate and stable promotion both read it back.
const SOURCE_SHA_RE = /<!-- source-sha: ([0-9a-f]{40}) -->/

export function sourceShaMarker(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a full commit sha: ${sha}`)
  return `<!-- source-sha: ${sha} -->`
}

export function sourceShaFromBody(body) {
  return SOURCE_SHA_RE.exec(body ?? '')?.[1] ?? null
}

// Each macOS leg writes its own `<channel>-mac.yml` listing only its own arch.
// Published separately, the second upload replaced the first and one arch lost
// its updater entirely. Merged, electron-updater's MacUpdater picks the file for
// the running arch by whether its url contains "arm64" (artifactName carries
// ${arch}, so both zips are distinguishable).
export function mergeMacManifests(arm64Text, x64Text) {
  const arm64 = yaml().load(arm64Text)
  const x64 = yaml().load(x64Text)
  if (arm64?.version !== x64?.version) {
    throw new Error(`macOS manifests disagree on version: ${arm64?.version} vs ${x64?.version}`)
  }
  const seen = new Set((arm64.files ?? []).map((file) => file.url))
  const files = [...(arm64.files ?? []), ...(x64.files ?? []).filter((file) => !seen.has(file.url))]
  return yaml().dump({ ...arm64, files }, { lineWidth: -1 })
}

const isArm64 = (url) => url.includes('arm64')

// What an installed app needs from one updater manifest. Returns the problems,
// empty when the manifest is usable.
export function checkManifest(text, platform, { version, assetNames }) {
  let doc
  try {
    doc = yaml().load(text)
  } catch (error) {
    return [`does not parse: ${error.message}`]
  }
  const problems = []
  if (doc?.version !== version) problems.push(`names version ${doc?.version}, expected ${version}`)
  const urls = (doc?.files ?? []).map((file) => String(file.url))
  if (urls.length === 0) problems.push('lists no files')
  for (const url of urls) {
    if (!assetNames.includes(url)) problems.push(`lists ${url}, which is not on the release`)
  }
  const zips = urls.filter((url) => url.endsWith('.zip'))
  if (platform === 'mac') {
    // MacUpdater throws ERR_UPDATER_ZIP_FILE_NOT_FOUND without a zip for the
    // running arch: a dmg alone installs by hand and never auto-updates.
    if (!zips.some(isArm64)) problems.push('has no Apple Silicon (arm64) .zip')
    if (!zips.some((url) => !isArm64(url))) problems.push('has no Intel (x64) .zip')
  } else if (platform === 'win') {
    if (!urls.some((url) => url.endsWith('.exe'))) problems.push('has no .exe')
  } else if (platform === 'linux') {
    if (!urls.some((url) => url.endsWith('.AppImage'))) problems.push('has no .AppImage')
  }
  return problems
}

export function manifestNames(channel) {
  return { win: `${channel}.yml`, mac: `${channel}-mac.yml`, linux: `${channel}-linux.yml` }
}

// Installers a complete release carries, beside the manifests.
export function missingInstallers(assetNames) {
  const has = (predicate) => assetNames.some(predicate)
  const missing = []
  if (!has((name) => name.endsWith('.dmg') && isArm64(name))) missing.push('an Apple Silicon .dmg')
  if (!has((name) => name.endsWith('.dmg') && !isArm64(name))) missing.push('an Intel .dmg')
  if (!has((name) => name.endsWith('.exe'))) missing.push('a .exe')
  if (!has((name) => name.endsWith('.AppImage'))) missing.push('an .AppImage')
  return missing
}

// The release body. Commit subjects are listed only when the source repository
// is public: the releases repository is public, and while the source is private
// its commit messages must not leak there.
export function buildReleaseNotes({ version, channel, sourceRepo, sha, sourcePrivate, commits = [] }) {
  const lines = [
    channel === 'preview'
      ? `Preview build of SprintEngine Studio ${version}. Installed preview builds update to newer previews.`
      : `SprintEngine Studio ${version}.`,
  ]
  if (!sourcePrivate) {
    lines.push('', `Built from [\`${sha.slice(0, 12)}\`](https://github.com/${sourceRepo}/commit/${sha}).`)
    if (commits.length > 0) {
      const shown = commits.slice(0, 100)
      lines.push('', '### Changes', '')
      for (const commit of shown) {
        lines.push(`- ${commit.subject} ([\`${commit.sha.slice(0, 7)}\`](https://github.com/${sourceRepo}/commit/${commit.sha}))`)
      }
      if (commits.length > shown.length) lines.push(`- ...and ${commits.length - shown.length} more`)
    }
  }
  lines.push('', sourceShaMarker(sha))
  return `${lines.join('\n')}\n`
}
