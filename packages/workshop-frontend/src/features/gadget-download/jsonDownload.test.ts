import { describe, expect, it } from 'vitest'
import { validateJsonDownload } from './jsonDownload'

describe('gadget JSON export boundary', () => {
  const report = { filename: 'concourse-feedback.json', text: '{"receipt":"feedback-123","context":{"gadgetId":3}}' }
  it('preserves exact JSON bytes and receipt metadata after a user gesture', () => {
    expect(validateJsonDownload(report, true)).toEqual(report)
  })
  it('refuses automatic exports without active user interaction', () => {
    expect(() => validateJsonDownload(report, false)).toThrow('Click Export')
  })
  it.each(['../report.json', '/tmp/report.json', 'https://example.com/report.json', 'report.html', 'report.json.exe', 'report\n.json'])('refuses unsafe filename %s', filename => {
    expect(() => validateJsonDownload({ ...report, filename }, true)).toThrow('filename')
  })
  it('rejects malformed JSON and byte-heavy Unicode without truncating', () => {
    expect(() => validateJsonDownload({ ...report, text: '<script>bad</script>' }, true)).toThrow('valid JSON')
    expect(() => validateJsonDownload({ ...report, text: JSON.stringify('界'.repeat(700_000)) }, true)).toThrow('2 MB')
    expect(() => validateJsonDownload({ ...report, text: ' '.repeat(2_000_001) }, true)).toThrow('2 MB')
  })
})
