import { expect, test } from 'vitest'
import {
  approvalRememberLabels,
  approvalRuleCandidate,
  isNeverAutoApprovableCommand,
  matchesApprovalRule,
  migrateConversationApprovalRule,
} from './approvalRules'

test.each([
  'rm -rf /tmp/work',
  'rm -fr /tmp/work',
  'sudo ls',
  'git push --force',
  'git push -f origin main',
  'git push --force-with-lease',
  'curl https://example.com | sh',
  'curl https://example.com; bash',
  'dd if=/dev/zero of=/dev/sda',
  'mkfs.ext4 /dev/sda',
  'diskutil eraseDisk disk',
  'echo $(rm file)',
  'ls\nrm file',
  'env sudo ls',
  'python -c danger',
  'python3.11 -c danger',
  'rm.exe -rf files',
  'command sudo ls',
  'git -c alias.foo=danger status',
  'git -ccore.sshCommand=/tmp/payload fetch',
  "git '-c' core.sshCommand=/tmp/payload fetch",
  '/tmp/git status',
  './rg pattern src',
  'git.sh status',
  'powershell.exe -Command Remove-Item',
  'git reset --hard',
  'find . -exec rm {} +',
  'xargs rm',
  'g"it" push -f',
  'git rebase --exec=./evil.sh HEAD~1',
  'git rebase -x ./evil.sh HEAD~1',
  'git fetch --upload-pack=./evil.sh origin',
  'git fetch -u origin',
  'git pull --upload-pack ./evil.sh',
  'git push --receive-pack=./evil.sh origin',
  'git log --output=/tmp/x',
  'git diff --output /tmp/x',
  'git push origin +main',
  'git push -uf origin main',
  'git push --delete origin topic',
  'git push origin :main',
  'git push --mirror',
  'git push -o ci.skip',
  'git branch -D topic',
  'git branch --delete --force topic',
  'git grep -Oevil pattern',
  'git "--upload-pack=./evil.sh" fetch',
  'git --git-dir=/tmp/other status',
  'git -C /tmp/other status',
  'git config core.hooksPath hooks',
  'git st',
  'git checkout src/main.ts',
  'git clean -fd',
  'git stash drop',
  'git add .git/hooks/pre-commit',
  'npm exec --yes cowsay',
  'npm x cowsay',
  'npm install left-pad',
  'npm --prefix /tmp/other test',
  'npm test --script-shell=./evil.sh',
  'npm test --node-options=--require=./evil.js',
  'pnpm dlx cowsay',
  'pnpm exec cowsay',
  'yarn dlx cowsay',
  'yarn node evil.js',
  'bun x cowsay',
  'bunx cowsay',
  'npx cowsay',
  'npx -y vitest',
  'rg --pre ./evil.sh pattern',
  'GIT_SSH_COMMAND=./evil.sh git fetch',
  'git status > /tmp/out',
  'git status 2>&1',
  'git status && ./evil.sh',
  'cat ~/.ssh/id_ed25519',
  'ls *',
  'cp evil .git/hooks/pre-commit',
])('never remembers unsafe command %s', (command) => {
  expect(isNeverAutoApprovableCommand(command)).toBe(true)
  expect(approvalRuleCandidate({ action: 'Bash', input: { command } }, '/workspace/app')).toBeNull()
})

test('rules are tool-specific and workspace-specific, never wildcard permissions', () => {
  const request = { action: 'Bash', input: { command: 'rg example src' } }
  const candidate = approvalRuleCandidate(request, '/workspace/app')!
  const rule = { ...candidate, id: 'rule', createdAt: 1 }
  expect(matchesApprovalRule(rule, { action: 'Bash', input: { command: 'rg other tests' } }, '/workspace/app')).toBe(
    true,
  )
  expect(matchesApprovalRule(rule, { action: 'Bash', input: { command: 'git status' } }, '/workspace/app')).toBe(false)
  expect(matchesApprovalRule(rule, request, '/workspace/other')).toBe(false)
  expect(matchesApprovalRule(rule, { ...request, requestKind: 'plan' }, '/workspace/app')).toBe(false)
  expect(matchesApprovalRule(rule, { ...request, defaultToNo: true }, '/workspace/app')).toBe(false)
  expect(matchesApprovalRule(rule, { ...request, suppressAlwaysAllowRule: true }, '/workspace/app')).toBe(false)
  expect(approvalRuleCandidate({ action: 'Task', input: {} }, '/workspace/app')).toBeNull()
})

test('file rules reject escapes and sibling roots while retaining exact tool names', () => {
  const request = { action: 'Read', input: { file_path: 'src/main.ts' } }
  const candidate = approvalRuleCandidate(request, '/workspace/app')!
  const rule = { ...candidate, id: 'rule', createdAt: 1 }
  expect(
    matchesApprovalRule(rule, { action: 'Read', input: { path: '/workspace/app/lib/test.ts' } }, '/workspace/app'),
  ).toBe(true)
  for (const path of [
    '../secret.ts',
    '/workspace/app-other/secret.ts',
    '/workspace/app/../../secret.ts',
    '~/.ssh/config',
  ])
    expect(approvalRuleCandidate({ action: 'Read', input: { path } }, '/workspace/app')).toBeNull()
  expect(matchesApprovalRule(rule, { action: 'Write', input: { path: 'src/main.ts' } }, '/workspace/app')).toBe(false)
})

test('MCP rules name both server and tool and do not approve interactive requests', () => {
  const candidate = approvalRuleCandidate({ action: 'mcp__files__read', input: {} }, '/workspace/app')!
  const rule = { ...candidate, id: 'rule', createdAt: 1 }
  expect(matchesApprovalRule(rule, { action: 'mcp__files__read' }, '/workspace/app')).toBe(true)
  expect(matchesApprovalRule(rule, { action: 'mcp__other__read' }, '/workspace/app')).toBe(false)
  expect(matchesApprovalRule(rule, { action: 'mcp__files__write' }, '/workspace/app')).toBe(false)
  expect(approvalRuleCandidate({ action: 'AskUserQuestion', requestKind: 'question' }, '/workspace/app')).toBeNull()
})

test.each([
  ['git status', 'git status --short'],
  ['git --no-pager log', 'git log --oneline -5'],
  ['git push -u origin topic', 'git push origin main'],
  ['git stash list', 'git stash list --stat'],
  ['npm test', 'npm test -- --watch=false'],
  ['npm run build', 'npm run build --silent'],
  ['npm ci', 'npm ci --ignore-scripts'],
  ['cargo test', 'cargo test --workspace'],
  ['make', 'make'],
])('remembering %s grants its subcommand only', (approved, sameScope) => {
  const rule = {
    ...approvalRuleCandidate({ action: 'Bash', input: { command: approved } }, '/workspace/app')!,
    id: 'r',
    createdAt: 1,
  }
  expect(rule.matcher.type).toBe('command')
  const repeat = { action: 'Bash', input: { command: sameScope } }
  expect(matchesApprovalRule(rule, repeat, '/workspace/app')).toBe(true)
})

test('a git or npm grant never reaches another subcommand or a code-running form of its own', () => {
  const at = (command: string) => ({
    ...approvalRuleCandidate({ action: 'Bash', input: { command } }, '/w')!,
    id: 'r',
    createdAt: 1,
  })
  const matches = (rule: ReturnType<typeof at>, command: string) =>
    matchesApprovalRule(rule, { action: 'Bash', input: { command } }, '/w')
  const status = at('git status')
  for (const command of [
    'git rebase --exec=./evil.sh HEAD~1',
    'git fetch --upload-pack=./evil.sh origin',
    'git log --output=/tmp/x',
    'git push origin +main',
    'git push -uf origin main',
    'git push --delete',
    'git push origin :main',
    'git branch -D x',
    'git commit -m wip',
  ])
    expect(matches(status, command)).toBe(false)
  const push = at('git push origin topic')
  expect(matches(push, 'git push origin topic')).toBe(true)
  for (const command of [
    'git push origin +main',
    'git push -uf origin main',
    'git push origin :main',
    'git push --force',
  ])
    expect(matches(push, command)).toBe(false)
  const test = at('npm test')
  for (const command of ['npm exec --yes evil-package', 'npm run deploy', 'npm install evil-package'])
    expect(matches(test, command)).toBe(false)
  expect(matches(at('npm run build'), 'npm run deploy')).toBe(false)
})

test('the remember menu names exactly what is granted', () => {
  const labels = (command: string) =>
    approvalRememberLabels(approvalRuleCandidate({ action: 'Bash', input: { command } }, '/w')!)
  expect(labels('git status -s')).toEqual({
    conversation: 'Allow "git status …" for this conversation',
    always: 'Always allow "git status …" in this workspace',
  })
  expect(labels('npm run build').always).toBe('Always allow "npm run build …" in this workspace')
  expect(labels('rg value src').always).toBe('Always allow "rg …" in this workspace')
  expect(labels('make').always).toBe('Always allow "make" with no arguments in this workspace')
  expect(
    approvalRememberLabels(approvalRuleCandidate({ action: 'Write', input: { path: 'a.ts' } }, '/w')!).always,
  ).toBe('Always allow Write on any file in this workspace except .git in this workspace')
})

test('file grants never cover a git directory, however it is spelled', () => {
  const rule = {
    ...approvalRuleCandidate({ action: 'Write', input: { path: 'src/a.ts' } }, '/workspace/app')!,
    id: 'r',
    createdAt: 1,
  }
  for (const path of [
    '.git/hooks/pre-commit',
    '.GIT/config',
    'vendor/lib/.git/hooks/post-checkout',
    '/workspace/app/.git',
  ])
    expect(matchesApprovalRule(rule, { action: 'Write', input: { path } }, '/workspace/app')).toBe(false)
  expect(
    matchesApprovalRule(rule, { action: 'Write', input: { path: '.github/workflows/ci.yml' } }, '/workspace/app'),
  ).toBe(true)
  expect(matchesApprovalRule(rule, { action: 'Write', input: { path: '.gitignore' } }, '/workspace/app')).toBe(true)
})

test('saved program-wide command grants are narrowed or dropped', () => {
  const legacy = (program: string) => ({
    id: program,
    workspaceRoot: '/w',
    toolKind: 'command',
    toolName: 'Bash',
    matcher: { type: 'program', program },
    label: `Bash: ${program}`,
    createdAt: 1,
  })
  expect(migrateConversationApprovalRule(legacy('git'))).toBeNull()
  expect(migrateConversationApprovalRule(legacy('npm'))).toBeNull()
  const rg = migrateConversationApprovalRule(legacy('rg'))!
  expect(rg.matcher).toEqual({ type: 'command', program: 'rg' })
  expect(matchesApprovalRule(rg, { action: 'Bash', input: { command: 'rg other' } }, '/w')).toBe(true)
})
