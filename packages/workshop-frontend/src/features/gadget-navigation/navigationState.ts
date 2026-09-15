import type { GadgetUiContext } from '@gadgets/workshop-shared/api'

const MAX_STATE_LENGTH = 4096
const HISTORY_KEY = 'cfosGadgetNavigation'

/** Scope UI preferences to one saved gadget or chat preview, never to the shared gadget data. */
export const navigationKey = (context: GadgetUiContext): string =>
  `cfos-ui:${context.workspaceId}:${context.gadgetId}:${context.chatId ?? 'saved'}`

/** Copy bounded JSON; gadget messages are untrusted even when their frame is authenticated. */
export const navigationState = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const encoded = JSON.stringify(value)
    if (encoded.length > MAX_STATE_LENGTH) return null
    const copy = JSON.parse(encoded)
    return copy && typeof copy === 'object' && !Array.isArray(copy) ? copy : null
  } catch { return null }
}

export const validGadgetView = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.(saved|\d+)\.[a-z][a-z0-9-]{0,31}$/.test(value)

const scope = (key: string) => key.split(':').slice(-2).join('.')

export const readNavigationState = (key: string): Record<string, unknown> | null => {
  const entry = window.history.state?.[HISTORY_KEY]
  let stored = null
  if (entry?.key === key) stored = navigationState(entry.value)
  else {
    try { stored = navigationState(JSON.parse(window.sessionStorage.getItem(key) ?? 'null')) }
    catch { /* Storage can be disabled. */ }
  }
  const selected = new URL(window.location.href).searchParams.get('gadgetView')
  if (validGadgetView(selected) && selected.startsWith(scope(key) + '.'))
    return { ...stored, view: selected.slice(scope(key).length + 1) }
  return stored
}

export const saveNavigationState = (key: string, value: unknown, replace: boolean): void => {
  const state = navigationState(value)
  if (!state) return
  const previous = readNavigationState(key)
  if (JSON.stringify(previous) === JSON.stringify(state)) return
  // Seed the current entry so Back restores the state before the first navigation.
  if (window.history.state?.[HISTORY_KEY]?.key !== key) {
    window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: { key, value: previous } }, '')
  }
  const entry = { ...window.history.state, [HISTORY_KEY]: { key, value: state } }
  const url = new URL(window.location.href)
  const selected = `${scope(key)}.${state.view}`
  if (validGadgetView(selected)) url.searchParams.set('gadgetView', selected)
  if (replace) window.history.replaceState(entry, '', url)
  else window.history.pushState(entry, '', url)
  try { window.sessionStorage.setItem(key, JSON.stringify(state)) } catch { /* Storage can be disabled. */ }
}
