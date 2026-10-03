import { webPageUrl } from './webLocation'

// A web tab's dropped files that have no path (phase 9 spec, 4.1 #10; 14.14):
// each one's bytes go to `/api/upload`, one request a file, and the server
// answers the path it saved it at, on its own machine, which is what the agent
// reads. A refusal comes back as the server worded it.

export async function uploadFilesToServer(files: File[], fetcher: typeof fetch = fetch): Promise<string[]> {
  const paths: string[] = []
  for (const file of files) {
    const url = new URL(webPageUrl('api/upload'))
    url.searchParams.set('name', file.name)
    let response: Response
    try {
      response = await fetcher(url.toString(), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
    } catch {
      throw new Error(`${file.name || 'That file'} could not be uploaded: Studio did not answer.`)
    }
    const answer = (await response.json().catch(() => null)) as {
      ok?: boolean
      path?: unknown
      message?: unknown
    } | null
    if (!response.ok || answer?.ok !== true || typeof answer.path !== 'string')
      throw new Error(
        typeof answer?.message === 'string' ? answer.message : `${file.name || 'That file'} could not be uploaded.`,
      )
    paths.push(answer.path)
  }
  return paths
}
