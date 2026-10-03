// The browser's own OS, as `process.platform` would name it (phase 9 spec,
// 3.3). It decides the Primary modifier, keyboard labels and anything else
// about the machine the person is typing on, which in a browser is not the
// machine the server runs on: a Windows browser on a Mac server must get Ctrl.

type NavigatorWithHints = Navigator & { userAgentData?: { platform?: string } }

export function browserPlatform(source: Pick<NavigatorWithHints, 'userAgent' | 'userAgentData'> = navigator): string {
  const hint = (source.userAgentData?.platform ?? '').toLowerCase()
  const agent = source.userAgent ?? ''
  if (hint === 'macos' || (!hint && /Macintosh|Mac OS X/u.test(agent) && !/iPhone|iPad/u.test(agent))) return 'darwin'
  if (hint === 'windows' || (!hint && /Windows/u.test(agent))) return 'win32'
  if (hint === 'android' || /Android/u.test(agent)) return 'android'
  if (/iPhone|iPad/u.test(agent)) return 'ios'
  return 'linux'
}
