import assert from 'node:assert/strict'
import { test } from 'vitest'
import { classifyLinkToken, FILE_EXTENSIONS, HOST_TLDS, type LinkToken } from './classifyLinkToken'

const href = { source: 'href' as const, platform: 'darwin' }
const text = { source: 'text' as const, platform: 'darwin' }
const code = { source: 'inlineCode' as const, platform: 'darwin' }

test('classifies explicit links, paths, positions, and ambiguous tokens', () => {
  const file = (path: string, line?: number, col?: number): LinkToken => ({
    type: 'file',
    path,
    ...(line ? { line } : {}),
    ...(col ? { col } : {}),
  })
  const url = (value: string): LinkToken => ({ type: 'url', href: value })
  const cases: Array<[string, typeof href | typeof text | typeof code, ReturnType<typeof classifyLinkToken>]> = [
    ['http://example.com/a', text, url('http://example.com/a')],
    ['https://example.org/x?q=1', code, url('https://example.org/x?q=1')],
    ['mailto:dev@example.com', href, url('mailto:dev@example.com')],
    ['file:///Users/dev/a%20b.ts', href, file('/Users/dev/a b.ts')],
    ['file:///tmp/test.ts#L8C2', href, file('/tmp/test.ts', 8, 2)],
    ['file:///C:/src/a.ts', href, file('C:/src/a.ts')],
    ['ftp://example.com/a', href, null],
    ['javascript:alert(1)', href, null],
    ['data:text/plain,hi', href, null],
    ['foo:bar', href, null],
    ['src/a.ts:12', text, file('src/a.ts', 12)],
    ['src/a.ts:12:4', code, file('src/a.ts', 12, 4)],
    ['src/a.ts#L9', href, file('src/a.ts', 9)],
    ['src/a.ts#L9C3', href, file('src/a.ts', 9, 3)],
    ['src/a.ts#L9-L20', href, file('src/a.ts', 9)],
    ['src/a.ts:0', href, null],
    ['src/a.ts:2:0', href, null],
    ['src/a.ts#L0', href, null],
    ['src/a.ts:999999999999999999', href, null],
    ['src/a.ts.', href, file('src/a.ts')],
    ['src/a.ts,', href, file('src/a.ts')],
    ['src/a.ts;!??', href, file('src/a.ts')],
    ['src/a.ts)', href, file('src/a.ts')],
    ['src/(a).ts', href, file('src/(a).ts')],
    ['src/a.ts]', href, file('src/a.ts')],
    ['src/a.ts}', href, file('src/a.ts')],
    ['src/a.ts"', href, file('src/a.ts')],
    ["src/a.ts'", href, file('src/a.ts')],
    ['./a', text, file('./a')],
    ['../a', text, file('../a')],
    ['~/a', text, file('~/a')],
    ['./folder', code, file('./folder')],
    ['../folder', href, file('../folder')],
    ['~/folder', code, file('~/folder')],
    ['.gitignore', text, null],
    ['/Users/dev/a', text, file('/Users/dev/a')],
    ['/home/dev/a', text, file('/home/dev/a')],
    ['/tmp/a', text, file('/tmp/a')],
    ['/var/a', text, file('/var/a')],
    ['/etc/a', text, file('/etc/a')],
    ['/opt/a', text, file('/opt/a')],
    ['/usr/a', text, file('/usr/a')],
    ['/private/a', text, file('/private/a')],
    ['/Volumes/work/a', text, file('/Volumes/work/a')],
    ['/mnt/a', text, file('/mnt/a')],
    ['/workspace/a', text, file('/workspace/a')],
    ['/workspaces/a', text, file('/workspaces/a')],
    ['/root/a', text, file('/root/a')],
    ['/srv/a', text, file('/srv/a')],
    ['/settings', text, null],
    ['/api/users', text, null],
    ['/app/x', text, null],
    ['C:\\src\\a.ts', text, file('C:\\src\\a.ts')],
    ['d:/src/a.ts', text, file('d:/src/a.ts')],
    ['\\\\host\\share\\a.ts', text, file('\\\\host\\share\\a.ts')],
    ['C:relative.ts', text, null],
    ['\\host\\share\\a.ts', text, null],
    ['src/a.ts', text, file('src/a.ts')],
    ['src/a.md', code, file('src/a.md')],
    ['src/Makefile', href, file('src/Makefile')],
    ['src/.env.local', code, file('src/.env.local')],
    ['src/Dockerfile', text, file('src/Dockerfile')],
    ['src/folder', text, null],
    ['src/unknown.xyzunknown', href, null],
    ['src/foo.bar()', href, null],
    ['example.com/path', text, url('example.com/path')],
    ['example.dev/docs', href, url('example.dev/docs')],
    ['example.org/a', code, url('example.org/a')],
    ['conf.d/x', text, null],
    ['next.config.js/notes', text, null],
    ['v1.2/notes', text, null],
    ['example.com/a.ts', text, file('example.com/a.ts')],
    ['example.com/a.md', text, file('example.com/a.md')],
    ['example.unknown/a', text, null],
    ['foo.ts', href, file('foo.ts')],
    ['foo.ts', code, file('foo.ts')],
    ['foo.ts', text, null],
    ['foo.ts:3', href, file('foo.ts', 3)],
    ['foo:3', code, file('foo', 3)],
    ['foo:3', text, null],
    ['foo.bar()', code, null],
    ['e.g.', href, null],
    ['1.2.3', href, null],
    ['obj.prop', code, null],
    ['Node.js', text, null],
    ['README', text, null],
    ['README', href, null],
    ['README:4', href, file('README', 4)],
    ['src/README', code, file('src/README')],
    ['src/LICENSE', text, file('src/LICENSE')],
    ['src/CHANGELOG', text, file('src/CHANGELOG')],
    ['src/CODEOWNERS', text, file('src/CODEOWNERS')],
    ['src/AUTHORS', text, file('src/AUTHORS')],
    ['src/NOTICE', text, file('src/NOTICE')],
    ['src/Procfile', text, file('src/Procfile')],
    ['src/Gemfile', text, file('src/Gemfile')],
    ['src/Rakefile', text, file('src/Rakefile')],
    ['src/Justfile', text, file('src/Justfile')],
    ['src/Brewfile', text, file('src/Brewfile')],
    ['src/Vagrantfile', text, file('src/Vagrantfile')],
    ['src/.gitignore', text, file('src/.gitignore')],
    ['src/.env.local', text, file('src/.env.local')],
  ]
  assert.ok(cases.length >= 100)
  for (const [token, ctx, expected] of cases) assert.deepEqual(classifyLinkToken(token, ctx), expected, token)
  assert.deepEqual(classifyLinkToken('/repo/src/a.ts', { ...text, cwd: '/repo' }), file('/repo/src/a.ts'))
  assert.equal(classifyLinkToken('/repo2/src/a.ts', { ...text, cwd: '/repo' }), null)
  assert.equal(classifyLinkToken('x'.repeat(2049), href), null)
  assert.ok(FILE_EXTENSIONS.has('ts'))
  assert.ok(HOST_TLDS.size >= 40)
})

test('classification is bounded for arbitrary input', () => {
  let seed = 17
  for (let i = 0; i < 10_000; i++) {
    let value = ''
    for (let j = 0, n = i % 60; j < n; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      value += String.fromCharCode(32 + (seed % 95))
    }
    const start = performance.now()
    classifyLinkToken(value, href)
    assert.ok(performance.now() - start < 10)
  }
})
