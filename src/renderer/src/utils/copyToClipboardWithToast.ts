import { showToast } from '../store/toastStore'

export async function copyToClipboardWithToast(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    showToast({ tone: 'good', title: 'Copied' })
    return true
  } catch {
    showToast({ tone: 'error', title: 'Could not copy to clipboard' })
    return false
  }
}
