// Runs the production GitHub raw-bundle downloader against the signed Doom
// payload, without publishing a repository or touching the installed app.
// Run after building/signing ../studio-doom: node scripts/testing/doom-plugin-import-smoke.cjs
// Set DOOM_WORKSPACE_ROOT for a checkout elsewhere.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { build } = require('esbuild')

async function main() {
  const root = path.resolve(__dirname, '../..')
  const bundleRoot = path.resolve(process.env.DOOM_WORKSPACE_ROOT || path.join(root, '../studio-doom'))
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'doom-import-'))
  try {
    await build({
      entryPoints: [path.join(root, 'src/main/marketplace/plugin-download.ts')],
      outfile: path.join(temp, 'download.cjs'), bundle: true, platform: 'node',
      format: 'cjs', packages: 'external',
    })
    const { downloadMarketplacePluginBundle } = require(path.join(temp, 'download.cjs'))
    const manifest = JSON.parse(await fs.readFile(path.join(bundleRoot, 'plugin.json'), 'utf8'))
    const base = 'https://raw.githubusercontent.com/example/studio-doom/main/'
    const entry = {
      id: manifest.id, name: manifest.displayName,
      publisher: { name: manifest.publisher, verified: false },
      summary: manifest.summary, category: manifest.category,
      latest: manifest.version, source: base + 'plugin.json', provides: ['module'],
      signature: manifest.signature,
    }
    let tamper = false
    let requests = 0
    const fetcher = async url => {
      assert.ok(url.startsWith(base), `unexpected network request: ${url}`)
      const relative = url.slice(base.length)
      assert.ok(!relative.includes('..'))
      let bytes = await fs.readFile(path.join(bundleRoot, relative))
      if (tamper && relative === 'module/runtime/runtime.js') bytes = Buffer.concat([bytes, Buffer.from('\n// tampered')])
      requests++
      return new Response(bytes, { status: 200 })
    }
    const options = { entry, trustContext: { trustedModules: new Map() }, stagingRoot: temp, fetcher }
    const result = await downloadMarketplacePluginBundle(options)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.classification, 'community')
    assert.equal(result.loadEligible, false, 'a signed community plugin must still require trust')
    assert.ok(requests > 10, 'downloaded the actual signed component tree')
    assert.deepEqual(
      await fs.readFile(path.join(result.stagedBundlePath, 'module/runtime/vendor/doom-shareware.zip')),
      await fs.readFile(path.join(bundleRoot, 'module/runtime/vendor/doom-shareware.zip')),
    )
    tamper = true
    const changed = await downloadMarketplacePluginBundle(options)
    assert.equal(changed.ok, false, 'mutated runtime bytes must fail import')
    assert.match(changed.message, /digest|signed|match/i)
    console.log('PASS: signed Doom imports within production limits, requires community trust, and rejects tampered runtime bytes.')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
