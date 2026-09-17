type ReconnectPopup = {
  closed: boolean
  opener: unknown
  location: { replace(url: string): void }
  close(): void
}

type ReconnectBrowser = {
  open(url: string, target: string): ReconnectPopup | null
  location: { assign(url: string): void }
}

/** Reserve the tab during the click gesture; an RPC round trip can outlive popup activation. */
export async function openGatekeeperReconnect(
  request: () => Promise<{ url: string }>,
  browser: ReconnectBrowser = window,
): Promise<void> {
  const popup = browser.open('about:blank', '_blank')
  if (popup) popup.opener = null

  try {
    const { url } = await request()
    if (!popup) {
      // Embedded browsers may block tabs entirely. Continue the authorized OAuth flow here.
      browser.location.assign(url)
    } else if (popup.closed) {
      throw new Error('Reconnection window was closed')
    } else {
      popup.location.replace(url)
    }
  } catch (error) {
    if (popup && !popup.closed) popup.close()
    throw error
  }
}
