import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import {
  MARKETPLACE_COMPONENT_KINDS,
  marketplaceAutomationPayloadIssues,
  type MarketplaceComponentFileDigest,
  type MarketplaceComponentKind,
  type MarketplaceManifestIssue,
  type MarketplacePluginComponents,
  type MarketplacePluginManifest,
} from './plugin-manifest.js'

export type MarketplaceComponentDigestOptions = {
  bytesLabel?: string
  blockedFileMessage?: (path: string) => string
}

type MarketplaceComponentDigestResult =
  | { ok: true; files: MarketplaceComponentFileDigest[] }
  | { ok: false; files: MarketplaceComponentFileDigest[]; issues: MarketplaceManifestIssue[] }

export type MarketplacePluginComponentsWithDigestsResult =
  | { ok: true; components: MarketplacePluginComponents }
  | { ok: false; issues: MarketplaceManifestIssue[] }

export function marketplaceComponentDigestPaths(manifest: Pick<MarketplacePluginManifest, 'components'>): string[] {
  return Array.from(new Set(componentKinds(manifest).flatMap((kind) =>
    manifest.components[kind]?.files?.map((file) => file.path) ?? []
  ))).sort()
}

function computeMarketplaceComponentFileDigestsSync(
  bundleRoot: string,
  componentPath: string,
  issuePath: string,
  options: MarketplaceComponentDigestOptions = {}
): MarketplaceComponentDigestResult {
  const absolutePath = join(bundleRoot, componentPath)
  const files: MarketplaceComponentFileDigest[] = []
  const issues: MarketplaceManifestIssue[] = []
  let componentPathMissing = false

  const visit = (absoluteFilePath: string): void => {
    let entryStat
    try {
      entryStat = statSync(absoluteFilePath)
    } catch (error) {
      if (isMissingFileError(error)) {
        if (absoluteFilePath === absolutePath) componentPathMissing = true
        issues.push({ path: `${issuePath}.path`, message: `declared path "${componentPath}" does not exist.` })
        return
      }
      throw error
    }

    const relPath = pathForManifest(relative(bundleRoot, absoluteFilePath))
    if (!isInsideOrEqualPath(bundleRoot, absoluteFilePath) || isPackExcludedComponentPath(relPath)) {
      issues.push({
        path: `${issuePath}.files`,
        message: options.blockedFileMessage?.(relPath) ?? `component file "${relPath}" cannot be signed, packed, or installed.`,
      })
      return
    }
    if (entryStat.isDirectory()) {
      for (const entry of readdirSync(absoluteFilePath).sort()) {
        visit(join(absoluteFilePath, entry))
      }
      return
    }
    if (!entryStat.isFile()) {
      issues.push({
        path: `${issuePath}.files`,
        message: `component path "${relPath}" must be a regular file or directory.`,
      })
      return
    }
    files.push({ path: relPath, sha256: createHash('sha256').update(readFileSync(absoluteFilePath)).digest('hex') })
  }

  visit(absolutePath)
  if (files.length === 0 && !componentPathMissing) {
    issues.push({ path: `${issuePath}.files`, message: `declared path "${componentPath}" contains no files.` })
  }
  const sortedFiles = files.sort((a, b) => a.path.localeCompare(b.path))
  return issues.length > 0 ? { ok: false, files: sortedFiles, issues } : { ok: true, files: sortedFiles }
}

export function computeMarketplacePluginComponentsWithDigestsSync(
  bundleRoot: string,
  components: MarketplacePluginComponents,
  options: MarketplaceComponentDigestOptions = {}
): MarketplacePluginComponentsWithDigestsResult {
  const signedComponents: MarketplacePluginComponents = {}
  const issues: MarketplaceManifestIssue[] = []
  for (const kind of MARKETPLACE_COMPONENT_KINDS) {
    const component = components[kind]
    if (!component) continue
    const result = computeMarketplaceComponentFileDigestsSync(bundleRoot, component.path, `components.${kind}`, options)
    if (!result.ok) issues.push(...result.issues)
    signedComponents[kind] = { path: component.path, files: result.files }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, components: signedComponents }
}

export function marketplaceComponentDigestMismatchIssuesSync(
  bundleRoot: string,
  // Only the declared components are read, so an unsigned (signature-optional)
  // authoring manifest is a valid input: digest integrity is orthogonal to the
  // signature.
  manifest: Pick<MarketplacePluginManifest, 'components'>,
  options: MarketplaceComponentDigestOptions = {}
): MarketplaceManifestIssue[] {
  const issues: MarketplaceManifestIssue[] = []
  const bytesLabel = options.bytesLabel ?? 'current bytes'
  for (const kind of componentKinds(manifest)) {
    const component = manifest.components[kind]
    if (!component) continue
    const actual = computeMarketplaceComponentFileDigestsSync(bundleRoot, component.path, `components.${kind}`, options)
    if (!actual.ok) issues.push(...actual.issues)
    const actualByPath = new Map(actual.files.map((file) => [file.path, file.sha256]))
    const expectedByPath = new Map((component.files ?? []).map((file) => [file.path, file.sha256]))

    for (const expected of component.files ?? []) {
      const actualDigest = actualByPath.get(expected.path)
      if (!actualDigest) {
        issues.push({ path: `components.${kind}.files`, message: `signed component file "${expected.path}" is missing.` })
      } else if (actualDigest !== expected.sha256) {
        issues.push({ path: `components.${kind}.files.${expected.path}`, message: `signed component file digest does not match ${bytesLabel}.` })
      }
    }
    for (const actualFile of actual.files) {
      if (!expectedByPath.has(actualFile.path)) {
        issues.push({ path: `components.${kind}.files`, message: `component file "${actualFile.path}" is not listed in signed digests.` })
      }
    }
  }
  return dedupeIssues(issues)
}

// Read the declared automation payload off disk and structurally validate it.
// The bundle gates (pack/sign, download-stage, install preflight) all reach the
// bytes through a bundle root, so the read lives here beside the digest walk
// rather than in the node-free manifest module.
export function marketplaceAutomationPayloadIssuesSync(
  bundleRoot: string,
  components: MarketplacePluginComponents
): MarketplaceManifestIssue[] {
  const component = components.automation
  if (!component) return []
  let source: string
  try {
    source = readFileSync(join(bundleRoot, component.path), 'utf8')
  } catch (error) {
    return [{
      path: 'components.automation.path',
      message: `automation payload "${component.path}" could not be read: ${error instanceof Error ? error.message : 'read error'}.`,
    }]
  }
  return marketplaceAutomationPayloadIssues(source)
}

function componentKinds(manifest: Pick<MarketplacePluginManifest, 'components'>): MarketplaceComponentKind[] {
  return MARKETPLACE_COMPONENT_KINDS.filter((kind) => manifest.components[kind] !== undefined)
}

function pathForManifest(path: string): string {
  return path.split(/[\\/]+/).join('/')
}

function isPackExcludedComponentPath(path: string): boolean {
  const segments = path.split('/')
  const name = segments[segments.length - 1] ?? ''
  return segments.includes('node_modules') || segments.includes('.git') || name.endsWith('.key') || name.endsWith('.pem')
}

function isInsideOrEqualPath(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}

function dedupeIssues(issues: MarketplaceManifestIssue[]): MarketplaceManifestIssue[] {
  const seen = new Set<string>()
  const result: MarketplaceManifestIssue[] = []
  for (const issue of issues) {
    const key = `${issue.path}\n${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(issue)
  }
  return result
}
