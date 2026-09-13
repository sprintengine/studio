// Run: node_modules/.bin/electron scripts/testing/module-assets-electron-smoke.cjs
// Exercises the production asset handler inside a sandboxed iframe.
const { app, BrowserWindow, protocol, session } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { mkdtempSync } = require('node:fs')
const temp = mkdtempSync(path.join(os.tmpdir(), 'studio-module-electron-'))
app.setPath('userData', path.join(temp, 'profile'))
require('esbuild').buildSync({
  entryPoints: [path.resolve(__dirname, '../../src/main/modules/module-assets.ts')],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  outfile: path.join(temp, 'handler.cjs'),
})
const {createModuleAssetHandler,isAllowedModuleAssetRequest} = require(path.join(temp, 'handler.cjs'))
protocol.registerSchemesAsPrivileged([{scheme:'studio-module', privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}])
app.whenReady().then(async()=>{
 try {
 const origin='studio-module://' + require('node:crypto').randomBytes(32).toString('hex')
 const root=path.join(temp, 'runtime')
 await fs.mkdir(root,{recursive:true})
 await fs.writeFile(root+'/index.html', `<script src="engine.js"></script>`)
 await fs.writeFile(root+'/engine.wasm', Buffer.from([0,97,115,109,1,0,0,0]))
 await fs.writeFile(root+'/worker.js', `postMessage('worker-ok')`)
 await fs.writeFile(root+'/engine.js', `(async()=>{try { await WebAssembly.instantiateStreaming(fetch('engine.wasm')); const worker=await new Promise(r=>{const w=new Worker('worker.js');w.onmessage=e=>{w.terminate();r(e.data)}}); const db=await new Promise((r,j)=>{const q=indexedDB.open('doom-smoke',1);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});db.close();parent.postMessage({ok:true,worker,origin:location.origin},'*')}catch(e){parent.postMessage({error:String(e)},'*')}})()`)
 protocol.handle('studio-module', createModuleAssetHandler({assetOrigin:()=>origin,discoverModules:async()=>({modules:[{manifest:{id:'doom'},moduleRoot:root,trust:{status:'trusted'}}],rejected:[]}),isEnabled:()=>true}))
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
 const shellFile=path.join(temp,'shell.html')
 await fs.writeFile(shellFile,'<html><body></body></html>')
 const shellUrl=require('node:url').pathToFileURL(shellFile).href
 session.defaultSession.webRequest.onBeforeRequest({urls:['studio-module://*/*']},(details,callback)=>callback({cancel:!isAllowedModuleAssetRequest(details,shellUrl)}))
 await win.loadURL('data:text/html,<html><body></body></html>')
 const crossOriginBlocked=await win.webContents.executeJavaScript(`fetch('studio-module://646f6f6d/engine.wasm').then(()=>false,()=>true)`)
 if(!crossOriginBlocked) throw new Error('Cross-origin asset reads must be blocked')
 const workerBlocked=await win.webContents.executeJavaScript(`new Promise(r=>{const url=URL.createObjectURL(new Blob(["fetch('studio-module://646f6f6d/engine.wasm').then(r=>postMessage(r.status===403),()=>postMessage(true))"],{type:'text/javascript'}));const w=new Worker(url);w.onmessage=e=>{w.terminate();URL.revokeObjectURL(url);r(e.data)}})`)
 if(!workerBlocked) throw new Error('Worker guessed a private module origin')
 await win.loadFile(shellFile)
 const result=await win.webContents.executeJavaScript(`new Promise((resolve)=>{const timer=setTimeout(()=>resolve({error:'timeout'}),10000);window.addEventListener('message', e=>{clearTimeout(timer);resolve(e.data)},{once:true});const f=document.createElement('iframe');f.sandbox='allow-scripts allow-same-origin allow-pointer-lock';f.src=${JSON.stringify(origin+'/index.html')};document.body.append(f)})`)
 console.log(JSON.stringify(result)); if(!result.ok || result.worker!=='worker-ok') throw new Error('Smoke failed')
 await fs.rm(temp, {recursive:true,force:true})
 app.exit(0)
 } catch(e){console.error(e);await fs.rm(temp,{recursive:true,force:true});app.exit(1)}
})
