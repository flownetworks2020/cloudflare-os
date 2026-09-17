import { describe, expect, it, vi } from 'vitest'
import { openGatekeeperReconnect } from './gatekeeperReconnect'

const oauthUrl = 'https://concourse.flownetworks.io/oauth/continue'

describe('gatekeeper reconnect navigation', () => {
  it('reserves a tab before the asynchronous RPC completes', async () => {
    let finish!: (value: { url: string }) => void
    const request = vi.fn<() => Promise<{ url: string }>>(
      () => new Promise<{ url: string }>((resolve) => { finish = resolve }),
    )
    const popup = {
      closed: false,
      opener: {} as unknown,
      location: { replace: vi.fn<(url: string) => void>() },
      close: vi.fn<() => void>(),
    }
    const browser = {
      open: vi.fn<() => typeof popup>(() => popup),
      location: { assign: vi.fn<(url: string) => void>() },
    }

    const reconnect = openGatekeeperReconnect(request, browser)
    expect(browser.open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(popup.opener).toBeNull()
    expect(request).toHaveBeenCalledOnce()
    expect(popup.location.replace).not.toHaveBeenCalled()

    finish({ url: oauthUrl })
    await reconnect
    expect(popup.location.replace).toHaveBeenCalledWith(oauthUrl)
    expect(browser.location.assign).not.toHaveBeenCalled()
  })

  it('uses the current tab when the embedded browser blocks popups', async () => {
    const browser = {
      open: vi.fn<() => null>(() => null),
      location: { assign: vi.fn<(url: string) => void>() },
    }
    await openGatekeeperReconnect(async () => ({ url: oauthUrl }), browser)
    expect(browser.location.assign).toHaveBeenCalledWith(oauthUrl)
  })

  it('closes the reserved tab when the reconnect RPC fails', async () => {
    const popup = {
      closed: false,
      opener: {} as unknown,
      location: { replace: vi.fn<(url: string) => void>() },
      close: vi.fn<() => void>(),
    }
    const browser = {
      open: vi.fn<() => typeof popup>(() => popup),
      location: { assign: vi.fn<(url: string) => void>() },
    }
    await expect(openGatekeeperReconnect(async () => { throw new Error('expired') }, browser))
      .rejects.toThrow('expired')
    expect(popup.close).toHaveBeenCalledOnce()
    expect(browser.location.assign).not.toHaveBeenCalled()
  })
})
