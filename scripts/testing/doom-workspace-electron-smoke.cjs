// Run: node_modules/.bin/electron scripts/testing/doom-workspace-electron-smoke.cjs
// Mounts the real Doom React contribution with Studio's actual shared UI kit.
const { app, BrowserWindow, protocol, session } = require('electron')
const fs = require('node:fs/promises')
const { mkdtempSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { build } = require('esbuild')
const root = path.resolve(__dirname, '../..')
const workspaceRoot = path.resolve(process.env.DOOM_WORKSPACE_ROOT || path.join(root, '../studio-doom'))
const temp = mkdtempSync(path.join(os.tmpdir(), 'studio-doom-wrapper-'))
app.setPath('userData', path.join(temp, 'profile'))
protocol.registerSchemesAsPrivileged([{scheme:'studio-module',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}])
const deadline = setTimeout(() => { console.error('Doom wrapper smoke timed out'); app.exit(1) }, 45000)
app.whenReady().then(async () => {
  let window
  try {
    await build({ entryPoints:[path.join(root,'src/main/modules/module-assets.ts')], bundle:true, platform:'node', format:'cjs', packages:'external', outfile:path.join(temp,'handler.cjs') })
    const { createModuleAssetHandler, isAllowedModuleAssetRequest } = require(path.join(temp,'handler.cjs'))
    session.defaultSession.webRequest.onBeforeRequest({urls:['studio-module://*/*']},(details,callback)=>callback({cancel:!isAllowedModuleAssetRequest(details,require('node:url').pathToFileURL(path.join(temp,'index.html')).href)}))
    const assetOrigin=()=> 'studio-module://' + require('node:crypto').randomBytes(32).toString('hex')
    const origin=assetOrigin()
    const installed = { manifest:{id:'studio-doom'}, moduleRoot:path.join(workspaceRoot,'module'), trust:{status:'trusted'} }
    protocol.handle('studio-module', createModuleAssetHandler({ assetOrigin:()=>origin, discoverModules:async()=>({modules:[installed],rejected:[]}), isEnabled:()=>true }))
    await build({
      stdin:{contents:`import React from 'react'; import { createRoot } from 'react-dom/client';
        import { registerRenderer } from ${JSON.stringify(path.join(workspaceRoot,'src/renderer.tsx'))};
        import { moduleAssetUrl } from './src/shared/modules/assets.ts';
        let Panel; const types=[]; const commands=[];
        registerRenderer({getAssetUrl:path=>moduleAssetUrl('studio-doom',path,${JSON.stringify(origin)}),registerPanel:(id,P)=>{Panel=P},registerWorkspaceType:t=>types.push(t),registerCommand:c=>commands.push(c)});
        if(!types[0]?.openOnFirstLoad || commands[0]?.id!=='open') throw new Error('Missing workspace launch contributions');
        window.__root=createRoot(document.getElementById('root'));
        window.__root.render(React.createElement(Panel,{workspaceId:'electron-wrapper-smoke'}));`,resolveDir:root,loader:'tsx'},
      bundle:true,platform:'browser',format:'iife',outfile:path.join(temp,'wrapper.js'), jsx:'automatic',loader:{'.css':'text'},
      alias:{'@multicode/module-sdk/ui':path.join(root,'src/renderer/src/modules/sdk-ui.ts'),'react':path.join(root,'node_modules/react'),'react-dom':path.join(root,'node_modules/react-dom')},
      define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'},logLevel:'error',
    })
    const css = await fs.readFile(path.join(root,'design-system/foundations/tokens.css'),'utf8')
    await fs.writeFile(path.join(temp,'index.html'),`<html><head><style>${css}\nhtml,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script src="wrapper.js"></script></body></html>`)
    window = new BrowserWindow({show:true,width:1000,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}})
    const errors=[]
    window.webContents.on('console-message',(event)=>{if(event.level==='error') errors.push(event.message)})
    await window.loadFile(path.join(temp,'index.html'))
    const waitFor = (predicate) => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+20000;const check=()=>{if((${predicate})())return resolve(true);if(Date.now()>end)return reject(new Error('UI condition timed out: '+document.body.innerText));setTimeout(check,50)};check()})`)
    const click = (label) => window.webContents.executeJavaScript(`(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!button)throw new Error('Button not found');button.click()})()`)
    await waitFor(`()=>document.body.innerText.includes('Play Doom')`)
    await click('Play Doom')
    await waitFor(`()=>document.body.innerText.includes('Pause / controls')`)
    await click('Pause / controls')
    await waitFor(`()=>document.body.innerText.includes('Doom paused')`)
    await click('Mute')
    await waitFor(`()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Unmute')`)
    await click('Resume')
    await waitFor(`()=>document.body.innerText.includes('Pause / controls')`)
    await window.webContents.executeJavaScript(`document.querySelector('.doom-workspace').style.display='none'`)
    await waitFor(`()=>document.body.innerText==='' || document.querySelector('.doom-overlay')?.textContent.includes('Doom paused')`)
    await window.webContents.executeJavaScript(`document.querySelector('.doom-workspace').style.display=''`)
    await waitFor(`()=>document.body.innerText.includes('Doom paused')`)
    const result=await window.webContents.executeJavaScript(`({header:document.querySelector('header')?.textContent.includes('Doom')===true, iframe:document.querySelector('iframe').src, muted:document.body.innerText.includes('Unmute')})`)
    if (!result.header) throw new Error('Real PanelHeader failed to render')
    if (!result.muted) throw new Error('Mute state was lost')
    await window.webContents.executeJavaScript('window.__root.unmount()')
    if (await window.webContents.executeJavaScript('document.querySelectorAll("iframe").length')) throw new Error('Unmount retained iframe')
    if (errors.length) throw new Error(errors.join('\n'))
    console.log(JSON.stringify({ok:true,...result,checks:['real SDK UI','runtime handshake','start','pause','mute','resume','hidden workspace pause','unmount']}))
    window.destroy()
    clearTimeout(deadline)
    await fs.rm(temp,{recursive:true,force:true})
    app.exit(0)
  } catch(error) {
    console.error(error)
    window?.destroy()
    clearTimeout(deadline)
    await fs.rm(temp,{recursive:true,force:true})
    app.exit(1)
  }
})
