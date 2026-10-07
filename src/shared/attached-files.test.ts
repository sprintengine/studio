import { expect, test } from 'vitest'

import { fileExtension, isNetworkPath, opensInDefaultApp } from './attached-files'

const PLATFORMS = ['darwin', 'win32', 'linux'] as const

test('documents, data, pictures, sound and video open in their apps on every platform', () => {
  for (const platform of PLATFORMS) {
    for (const path of [
      '/Users/dev/Desktop/Quarterly report.pdf',
      '/Users/dev/Desktop/brief.docx',
      '/Users/dev/Desktop/budget.XLSX',
      '/Users/dev/Desktop/deck.pptx',
      '/Users/dev/Desktop/minutes.odt',
      '/Users/dev/Desktop/letter.rtf',
      '/Users/dev/Desktop/export.csv',
      '/Users/dev/Desktop/notes.md',
      '/Users/dev/Desktop/config.yaml',
      '/Users/dev/Desktop/server.log',
      '/Users/dev/Desktop/shot.png',
      '/Users/dev/Desktop/memo.m4a',
      '/Users/dev/Desktop/demo.mov',
      'C:\\Users\\dev\\Documents\\plan.txt',
    ])
      expect(opensInDefaultApp(path, platform), `${path} on ${platform}`).toBe(true)
  }
})

test('anything not on the list is only revealed, on every platform: programs, scripts, shortcuts and the rest', () => {
  for (const platform of PLATFORMS) {
    for (const path of [
      // Programs and installers
      '/Applications/Calculator.app',
      '/Users/dev/Downloads/Installer.pkg',
      'C:\\Users\\dev\\Downloads\\setup.EXE',
      'C:\\Users\\dev\\Downloads\\setup.msi',
      'C:\\Users\\dev\\Downloads\\Tool.appinstaller',
      '/home/dev/app.AppImage',
      '/home/dev/launcher.desktop',
      // Scripts, in every host that runs one
      '/Users/dev/Desktop/run.command',
      '/Users/dev/Desktop/deploy.sh',
      '/Users/dev/Desktop/tool.py',
      '/Users/dev/Desktop/helper.js',
      'C:\\Users\\dev\\Desktop\\start.bat',
      'C:\\Users\\dev\\Desktop\\fix.ps1',
      'C:\\Users\\dev\\Desktop\\task.ws',
      'C:\\Users\\dev\\Desktop\\part.wsc',
      'C:\\Users\\dev\\Desktop\\part.sct',
      'C:\\Users\\dev\\Desktop\\hotkeys.ahk',
      'C:\\Users\\dev\\Desktop\\console.msh1',
      // Help files, add-ins and saved places that act on a double-click
      'C:\\Users\\dev\\Desktop\\manual.chm',
      'C:\\Users\\dev\\Desktop\\addin.xll',
      'C:\\Users\\dev\\Desktop\\Docs.library-ms',
      'C:\\Users\\dev\\Desktop\\Find.search-ms',
      'C:\\Users\\dev\\Desktop\\panel.settingcontent-ms',
      'C:\\Users\\dev\\Desktop\\portal.website',
      '/Users/dev/Desktop/app.jnlp',
      // Shortcuts and locations
      'C:\\Users\\dev\\Desktop\\Shortcut.lnk',
      'C:\\Users\\dev\\Desktop\\site.url',
      '/Users/dev/Desktop/place.fileloc',
      // Disk images and archives: opening one mounts or expands it
      'C:\\Users\\dev\\Downloads\\disk.iso',
      'C:\\Users\\dev\\Downloads\\disk.img',
      'C:\\Users\\dev\\Downloads\\disk.vhdx',
      '/Users/dev/Downloads/disk.dmg',
      '/Users/dev/Downloads/bundle.zip',
      // Pages a browser would run, and documents that carry macros
      '/Users/dev/Desktop/page.html',
      '/Users/dev/Desktop/drawing.svg',
      '/Users/dev/Desktop/budget.xlsm',
      // No extension: nothing says what it is
      '/Users/dev/Desktop/README',
    ])
      expect(opensInDefaultApp(path, platform), `${path} on ${platform}`).toBe(false)
  }
})

test('a Windows name the shell reads otherwise than it is spelled is never opened there', () => {
  // A stream of a program, named like a document.
  expect(opensInDefaultApp('C:\\Users\\dev\\Downloads\\setup.exe:notes.pdf', 'win32')).toBe(false)
  // The shell trims a trailing dot or space before it decides what the file is.
  expect(opensInDefaultApp('C:\\Users\\dev\\Downloads\\report.pdf.', 'win32')).toBe(false)
  expect(opensInDefaultApp('C:\\Users\\dev\\Downloads\\report.pdf ', 'win32')).toBe(false)
  // The drive's colon is not the name's.
  expect(opensInDefaultApp('C:\\Users\\dev\\Downloads\\report.pdf', 'win32')).toBe(true)
  // A colon in a macOS name is just a character.
  expect(opensInDefaultApp('/Users/dev/Notes: final.pdf', 'darwin')).toBe(true)
})

test('a UNC or device path is a network path on Windows, and nowhere else says so by its spelling', () => {
  for (const path of [
    '\\\\attacker\\share\\x.pdf',
    '//attacker/share/x.pdf',
    '\\\\?\\UNC\\attacker\\share\\x.pdf',
    '\\\\.\\pipe\\x',
  ])
    expect(isNetworkPath(path, 'win32'), path).toBe(true)
  expect(isNetworkPath('C:\\Users\\dev\\report.pdf', 'win32')).toBe(false)
  expect(isNetworkPath('\\\\attacker\\share\\x.pdf', 'darwin')).toBe(false)
  expect(isNetworkPath('/Volumes/share/x.pdf', 'darwin')).toBe(false)
  expect(isNetworkPath('/mnt/share/x.pdf', 'linux')).toBe(false)
})

test('the extension is the last segment’s, lower-cased; a dotfile or a bare name has none', () => {
  expect(fileExtension('/Users/dev/release.tar.GZ')).toBe('gz')
  expect(fileExtension('C:\\Users\\dev\\Report.Final.DOCX')).toBe('docx')
  expect(fileExtension('/Users/dev/.zshrc')).toBe('')
  expect(fileExtension('/Users/dev/Makefile')).toBe('')
  expect(fileExtension('/Users/dev/folder.d/notes')).toBe('')
})
