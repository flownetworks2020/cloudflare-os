// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { navigationKey, navigationState, readNavigationState, saveNavigationState } from './navigationState'

const saved = 'cfos-ui:workspace:3:saved'
const preview = 'cfos-ui:workspace:3:0'
beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState({ router: 'retained' }, '', '/workspace/test?chat=0')
})

describe('gadget navigation isolation', () => {
  it('distinguishes saved gadgets, previews and different workspaces', () => {
    const context = { schema: 'cfos.gadget-ui-context.v1' as const, workspaceId: 'a'.repeat(64), gadgetId: 0, chatId: null, view: 'saved' as const, clientCodeSha256: 'b'.repeat(64) }
    expect(navigationKey(context)).not.toBe(navigationKey({ ...context, chatId: 0, view: 'chat_preview' }))
    expect(navigationKey(context)).not.toBe(navigationKey({ ...context, workspaceId: 'c'.repeat(64) }))
  })
  it('keeps queue text out of URLs and preserves the host route state', () => {
    saveNavigationState(saved, { view: 'needs', query: 'private queue search' }, true)
    expect(window.location.search).toContain('gadgetView=3.saved.needs')
    expect(window.location.search).not.toContain('private')
    expect(window.history.state.router).toBe('retained')
    expect(readNavigationState(saved)?.query).toBe('private queue search')
    expect(readNavigationState(preview)).toBeNull()
  })
  it('restores the previous entry without substituting newer session state', () => {
    saveNavigationState(saved, { view: 'needs', query: 'first' }, true)
    const prior = window.history.state
    saveNavigationState(saved, { view: 'work', query: 'second' }, false)
    window.history.replaceState(prior, '', '/workspace/test?gadgetView=3.saved.needs')
    expect(readNavigationState(saved)).toEqual({ view: 'needs', query: 'first' })
  })
  it('honors a shared view URL without importing another gadget state', () => {
    window.history.replaceState(null, '', '/workspace/test?gadgetView=3.saved.estate')
    expect(readNavigationState(saved)).toEqual({ view: 'estate' })
    expect(readNavigationState(preview)).toBeNull()
  })
  it('rejects oversized and non-object payloads', () => {
    expect(navigationState({ query: 'x'.repeat(4096) })).toBeNull()
    expect(navigationState([])).toBeNull()
    expect(navigationState({ toJSON: () => 'not an object' })).toBeNull()
    saveNavigationState(saved, { query: 'x'.repeat(4096) }, false)
    expect(readNavigationState(saved)).toBeNull()
  })
})
