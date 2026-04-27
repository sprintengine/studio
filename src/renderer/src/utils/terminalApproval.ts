const ARTIFACT_APPROVAL_SUBMIT_DELAY_MS = 15000

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export async function sendArtifactApprovalToTerminal(sessionId: string): Promise<void> {
  await window.api.terminalWrite(sessionId, 'i approve')
  await wait(ARTIFACT_APPROVAL_SUBMIT_DELAY_MS)
  await window.api.terminalWrite(sessionId, '\r')
}
