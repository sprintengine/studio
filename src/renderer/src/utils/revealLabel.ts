/** What "show this file where it lives" is called on this platform. */
export function revealLabel(platform: string): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in file manager'
}
