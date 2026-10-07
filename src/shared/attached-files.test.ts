import { expect, test } from 'vitest'

import { fileExtension, launchesWhenOpened } from './attached-files'

test('documents, data and pictures open in their apps on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const path of [
      '/Users/dev/Desktop/Quarterly report.pdf',
      '/Users/dev/Desktop/brief.docx',
      '/Users/dev/Desktop/budget.XLSX',
      '/Users/dev/Desktop/deck.pptx',
      '/Users/dev/Desktop/export.csv',
      '/Users/dev/Desktop/notes.md',
      '/Users/dev/Desktop/bundle.zip',
      '/Users/dev/Desktop/shot.png',
      'C:\\Users\\dev\\Documents\\plan.txt',
      '/Users/dev/Desktop/README',
    ])
      expect(launchesWhenOpened(path, platform), `${path} on ${platform}`).toBe(false)
  }
})

test('programs, installers, scripts and shortcuts are never opened, only revealed', () => {
  for (const path of [
    '/Applications/Calculator.app',
    '/Users/dev/Downloads/Installer.pkg',
    '/Users/dev/Desktop/run.command',
    '/Users/dev/Desktop/deploy.sh',
    '/Users/dev/Desktop/tool.py',
    '/Users/dev/Desktop/game.jar',
    '/Users/dev/Desktop/place.fileloc',
    'C:\\Users\\dev\\Downloads\\setup.EXE',
    'C:\\Users\\dev\\Downloads\\setup.msi',
    'C:\\Users\\dev\\Desktop\\start.bat',
    'C:\\Users\\dev\\Desktop\\start.cmd',
    'C:\\Users\\dev\\Desktop\\fix.ps1',
    'C:\\Users\\dev\\Desktop\\Shortcut.lnk',
    'C:\\Users\\dev\\Desktop\\site.url',
    '/home/dev/app.AppImage',
    '/home/dev/launcher.desktop',
  ])
    expect(launchesWhenOpened(path, 'darwin') || launchesWhenOpened(path, 'win32'), path).toBe(true)
  expect(launchesWhenOpened('/Users/dev/Desktop/deploy.sh', 'darwin')).toBe(true)
  expect(launchesWhenOpened('C:\\Users\\dev\\Downloads\\setup.exe', 'win32')).toBe(true)
})

test('a script the Windows script host runs is refused there and opens in an editor elsewhere', () => {
  expect(launchesWhenOpened('C:\\Users\\dev\\Desktop\\helper.js', 'win32')).toBe(true)
  expect(launchesWhenOpened('/Users/dev/project/helper.js', 'darwin')).toBe(false)
})

test('the extension is the last segment’s, lower-cased; a dotfile or a bare name has none', () => {
  expect(fileExtension('/Users/dev/release.tar.GZ')).toBe('gz')
  expect(fileExtension('C:\\Users\\dev\\Report.Final.DOCX')).toBe('docx')
  expect(fileExtension('/Users/dev/.zshrc')).toBe('')
  expect(fileExtension('/Users/dev/Makefile')).toBe('')
  expect(fileExtension('/Users/dev/folder.d/notes')).toBe('')
})
