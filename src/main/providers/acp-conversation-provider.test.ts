import { mkdtemp, writeFile, readFile, rm, symlink, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createAcpConversationProvider, confinedAcpPath, acpToolKind } from './acp-conversation-provider'
import type { ConversationEvent } from '../../shared/conversation-runtime'

// A separate process speaks JSON-RPC over real stdio, including agent-to-client
// permission and file requests. No installed CLI or network is needed in CI.
const agent = `
const { createInterface } = require('node:readline');
let prompt, serial=100, pending=new Map();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const result=(id,result)=>send({id,result});
const update=update=>send({method:'session/update',params:{sessionId:'native',update}});
const request=(method,params)=>new Promise(resolve=>{const id=++serial;pending.set(id,resolve);send({id,method,params})});
createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(!m.method){pending.get(m.id)?.(m.result||{error:m.error});pending.delete(m.id);return}
 if(m.method==='initialize')return result(m.id,{protocolVersion:1,agentCapabilities:{loadSession:!process.env.NO_LOAD,promptCapabilities:{image:true}},authMethods:[]});
 if(m.method==='session/new'||m.method==='session/load'){
   if(m.method==='session/load')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'REPLAY SHOULD BE SUPPRESSED'}});
   return result(m.id,{...(m.method==='session/new'?{sessionId:'native'}:{}),modes:{currentModeId:'agent',availableModes:[{id:'agent',name:'Agent'},{id:'plan',name:'Plan'},{id:'ask',name:'Ask'}]},configOptions:[]});
 }
 if(m.method==='session/set_mode')return result(m.id,{});
 if(m.method==='session/cancel'){if(prompt)result(prompt,{stopReason:'cancelled'});prompt=null;return}
 if(m.method!=='session/prompt')return result(m.id,{});
 prompt=m.id;const text=p.prompt[0].text;
 if(text.includes('inspect history')){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text}});result(m.id,{stopReason:'end_turn'});return}
 if(text==='crash')process.exit(2);
 update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'Thinking'}});
 if(text==='hang'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'waiting'}});return}
 update({sessionUpdate:'tool_call',toolCallId:'tool',kind:'edit',title:'Write',rawInput:{path:'result.txt'},status:'pending'});
 const permission=await request('session/request_permission',{sessionId:'native',toolCall:{toolCallId:'tool',kind:'edit',name:'Write'},options:[{kind:text==='broad'?'allow_always':'allow_once',optionId:'allow',name:'Allow'},{kind:'reject_once',optionId:'deny',name:'Deny'}]});
 if(permission.outcome?.outcome==='selected'&&permission.outcome.optionId==='allow'){
  if(text==='write')await request('fs/write_text_file',{sessionId:'native',path:process.cwd()+'/result.txt',content:'approved write'});
  update({sessionUpdate:'tool_call_update',toolCallId:'tool',status:'completed',content:[{type:'diff',path:'result.txt',oldText:'',newText:'approved write'}]});
 }
 update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:permission.outcome?.outcome==='selected'?'Done':'Denied'}});
 result(m.id,{stopReason:'end_turn',usage:{inputTokens:10,outputTokens:2,totalTokens:12}});prompt=null;
});
`
async function fixture(resume = false) {
  const root = await mkdtemp(join(tmpdir(), 'acp-provider-'))
  const input = {
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'test-acp',
    modelId: 'default',
    workspaceRoot: root,
    ...(resume
      ? {
          resumeSessionId: 'old',
          fallbackHistory: [
            { role: 'user' as const, content: 'persisted question' },
            { role: 'assistant' as const, content: 'persisted answer' },
          ],
        }
      : {}),
  }
  const provider = createAcpConversationProvider(
    {
      id: input.providerId,
      displayName: 'Test agent',
      cli: 'test',
      argv: ['-e', agent],
      authHint: 'Configure test agent.',
      images: true,
      planMode: true,
    },
    {
      detect: async () => process.execPath,
      buildEnv: async () => ({ PATH: process.env.PATH, ...(resume ? { NO_LOAD: '1' } : {}) }),
      startupTimeoutMs: 2000,
    },
  )
  await provider.startSession(input)
  return {
    root,
    input,
    provider,
    cleanup: async () => {
      provider.disposeAll?.()
      await rm(root, { recursive: true, force: true })
    },
  }
}
async function turn(f: Awaited<ReturnType<typeof fixture>>, message: string) {
  const events: ConversationEvent[] = []
  for await (const event of await f.provider.sendTurn({ ...f.input, turnId: 'turn', requestId: 'request', message })) {
    events.push(event)
    if (event.type === 'approval_requested')
      await f.provider.resolveApproval({
        ...f.input,
        turnId: 'turn',
        requestId: String(event.payload?.requestId),
        approved: true,
      })
  }
  return events
}

test('ACP streams text, reasoning, typed edits, permissions, usage and workspace writes over stdio', async () => {
  const f = await fixture()
  try {
    const events = await turn(f, 'write')
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        'reasoning_delta',
        'tool_started',
        'tool_output',
        'approval_requested',
        'content_delta',
        'usage_updated',
        'turn_completed',
      ]),
    )
    expect(events.find((event) => event.type === 'tool_started')?.payload).toMatchObject({
      kind: 'file_edit',
      toolUseId: 'tool',
      input: { path: 'result.txt' },
    })
    expect(events.filter((event) => event.type === 'approval_requested')).toHaveLength(2)
    expect(await readFile(join(f.root, 'result.txt'), 'utf8')).toBe('approved write')
    expect(f.provider.listLiveSessions?.()[0]).toMatchObject({
      hasChildProcess: true,
      turnActive: false,
      providerSessionId: 'native',
    })
  } finally {
    await f.cleanup()
  }
})
test('ACP idle disposal resumes its native session without replaying old text into the turn', async () => {
  const f = await fixture()
  try {
    await turn(f, 'first')
    expect(f.provider.disposeChildProcess?.('session')).toBe(true)
    const events = await turn(f, 'second')
    expect(events.filter((event) => event.type === 'content_delta').map((event) => event.payload?.text)).toEqual([
      'Done',
    ])
  } finally {
    await f.cleanup()
  }
})
test('ACP cancellation and child crashes always terminate streaming', async () => {
  const f = await fixture()
  try {
    const events: ConversationEvent[] = []
    for await (const event of await f.provider.sendTurn({
      ...f.input,
      turnId: 'turn',
      requestId: 'request',
      message: 'hang',
    })) {
      events.push(event)
      if (event.type === 'content_delta') await f.provider.interrupt(f.input)
    }
    expect(events.some((event) => event.type === 'turn_failed')).toBe(true)
    expect((await turn(f, 'crash')).some((event) => event.type === 'turn_failed')).toBe(true)
  } finally {
    await f.cleanup()
  }
})
test('ACP without native loading restores persisted history after application restart', async () => {
  const f = await fixture(true)
  try {
    const content = (await turn(f, 'inspect history')).find((event) => event.type === 'content_delta')?.payload?.text
    expect(content).toContain('persisted question')
    expect(content).toContain('persisted answer')
    expect(content).toContain('inspect history')
  } finally {
    await f.cleanup()
  }
})
test('ACP shutdown during executable discovery never spawns a late child', async () => {
  let finish!: (path: string) => void
  const detection = new Promise<string>((resolve) => {
    finish = resolve
  })
  const provider = createAcpConversationProvider(
    {
      id: 'late',
      displayName: 'Late',
      cli: 'test',
      argv: ['-e', agent],
      authHint: 'Configure agent.',
      images: false,
      planMode: false,
    },
    { detect: () => detection, buildEnv: async () => ({}) },
  )
  const pending = provider.startSession({
    sessionId: 'late',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'late',
    modelId: 'default',
    workspaceRoot: tmpdir(),
  })
  provider.disposeAll?.()
  finish(process.execPath)
  await expect(pending).rejects.toThrow('stopped during startup')
  expect(provider.listLiveSessions?.()).toEqual([])
})
test('ACP handshake timeout disposes the child and cannot publish a late connection', async () => {
  const slow = `setTimeout(()=>{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:0,result:{protocolVersion:1}})+'\\n')},2000);process.stdin.resume()`
  const provider = createAcpConversationProvider(
    {
      id: 'slow',
      displayName: 'Slow',
      cli: 'test',
      argv: ['-e', slow],
      authHint: 'Configure agent.',
      images: false,
      planMode: false,
    },
    { detect: async () => process.execPath, buildEnv: async () => ({}), startupTimeoutMs: 20 },
  )
  await expect(
    provider.startSession({
      sessionId: 'slow',
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'slow',
      modelId: 'default',
      workspaceRoot: tmpdir(),
    }),
  ).rejects.toThrow('timed out')
  expect(provider.listLiveSessions?.()).toEqual([])
  provider.disposeAll?.()
})
test('ACP refuses permission presets that the selected CLI cannot enforce', async () => {
  const f = await fixture()
  try {
    expect(await f.provider.setPermissionPreset?.({ ...f.input, permissionPreset: 'manual' })).toMatchObject({
      ok: false,
    })
    await expect(
      f.provider.startSession({ ...f.input, sessionId: 'other', permissionPreset: 'bypass' }),
    ).rejects.toThrow('cannot enforce')
  } finally {
    await f.cleanup()
  }
})
test('ACP never upgrades an allow-once decision to a persistent agent permission', async () => {
  const f = await fixture()
  try {
    expect((await turn(f, 'broad')).find((event) => event.type === 'content_delta')?.payload?.text).toBe('Denied')
  } finally {
    await f.cleanup()
  }
})
test('ACP file helpers reject traversal, absolute escapes and symlink ancestors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-files-'))
  try {
    await mkdir(join(root, 'workspace'))
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside', 'secret'), 'private')
    await symlink(join(root, 'outside'), join(root, 'workspace', 'link'))
    const cwd = join(root, 'workspace')
    await expect(confinedAcpPath(cwd, '../outside/secret')).rejects.toThrow('outside')
    await expect(confinedAcpPath(cwd, join(root, 'outside', 'secret'))).rejects.toThrow('outside')
    await expect(confinedAcpPath(cwd, 'link/secret')).rejects.toThrow('Symbolic')
    await expect(confinedAcpPath(cwd, 'link/new', true)).rejects.toThrow('Symbolic')
    expect(await confinedAcpPath(cwd, 'new', true)).toBe(join(await realpath(cwd), 'new'))
    expect(acpToolKind('execute')).toBe('command')
    expect(acpToolKind('think')).toBe('other')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
