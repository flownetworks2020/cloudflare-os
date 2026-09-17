/** Validate a gadget's JSON export. The host never fetches a gadget-supplied URL. */
export function validateJsonDownload(value: unknown, userActivated: boolean): { filename: string; text: string } {
  if (!userActivated) throw new Error('Click Export again to start the download.')
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON export.')
  const { filename, text } = value as Record<string, unknown>
  if (typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,100}\.json$/.test(filename)) {
    throw new Error('Export requires a plain .json filename.')
  }
  if (typeof text !== 'string' || text.length > 2_000_000 || new TextEncoder().encode(text).length > 2_000_000) {
    throw new Error('JSON export exceeds 2 MB.')
  }
  try { JSON.parse(text) } catch { throw new Error('Export is not valid JSON.') }
  return { filename, text }
}

/** Download validated bytes in the trusted host, retaining the gadget's sandbox restrictions. */
export function downloadJson(value: { filename: string; text: string }): void {
  const url = URL.createObjectURL(new Blob([value.text], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = value.filename
  document.body.append(anchor)
  try { anchor.click() } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

/** Injected promise-based export API; acknowledgement means initiated, not saved to disk. */
export const JSON_DOWNLOAD_CLIENT = `globalThis.CFOS_DOWNLOAD = Object.freeze({
  json: (filename, value) => new Promise((resolve, reject) => {
    let text;
    try { text = JSON.stringify(value, null, 2); } catch { reject(new Error('Export is not valid JSON.')); return; }
    if (typeof text !== 'string' || text.length > 2000000) { reject(new Error('JSON export exceeds 2 MB.')); return; }
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Export host did not respond.')); }, 5000);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close();
      if (event.data?.ok === true) resolve(); else reject(new Error(event.data?.error || 'Export could not start.'));
    };
    window.parent.postMessage({type: 'cfos-download-json', filename, text}, '*', [channel.port2]);
  })
});\n`;
