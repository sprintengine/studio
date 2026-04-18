export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', cs: 'csharp',
    cpp: 'cpp', c: 'c', h: 'c', rb: 'ruby', php: 'php',
    html: 'html', css: 'css', scss: 'scss', json: 'json',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    sh: 'shell', bash: 'shell', sql: 'sql', xml: 'xml',
  }
  return map[ext] ?? 'plaintext'
}
