import { describe, expect, it } from 'vitest'
import { anchorFinding, suggestionKey, toSuggestions, type SideLines } from '../../src/claude/findings'
import type { Finding } from '../../src/claude/types'
import { numberLines } from '../../src/review/lines'

const NEW = ['function total(items) {', '  let sum = 0', '  console.log(sum)', '  for (const item of items) sum += item.price', '  return sum', '}']
const OLD = ['function total(items) {', '  let sum = 0', '  for (const item of items) sum += item.price * item.qty', '  return sum', '}']
const lines: SideLines = { old: numberLines(OLD.join('\n')), new: numberLines(NEW.join('\n')) }

const finding = (overrides: Partial<Finding>): Finding => ({
  path: 'src/cart.ts',
  side: 'new',
  line: 3,
  lineText: '  console.log(sum)',
  severity: 'suggestion',
  title: 'Leftover debug log',
  body: 'Remove it.',
  ...overrides,
})

describe('anchorFinding', () => {
  it('anchors on the reported line with surrounding context', () => {
    expect(anchorFinding(finding({}), lines)).toEqual({
      line: 3,
      side: 'new',
      text: '  console.log(sum)',
      before: ['function total(items) {', '  let sum = 0'],
      after: ['  for (const item of items) sum += item.price', '  return sum', '}'],
    })
  })

  it('accepts the reported line when only whitespace differs', () => {
    expect(anchorFinding(finding({ lineText: 'console.log(sum)' }), lines)?.line).toBe(3)
  })

  it('moves to the line carrying the reported text when the number is off', () => {
    expect(anchorFinding(finding({ line: 5 }), lines)?.line).toBe(3)
    expect(anchorFinding(finding({ line: 40 }), lines)?.line).toBe(3)
  })

  it('anchors removed lines on the old side', () => {
    const anchor = anchorFinding(finding({ side: 'old', line: 3, lineText: '  for (const item of items) sum += item.price * item.qty' }), lines)
    expect(anchor).toMatchObject({ side: 'old', line: 3, before: ['function total(items) {', '  let sum = 0'] })
  })

  it('falls back to the reported line when the text is nowhere in the file', () => {
    expect(anchorFinding(finding({ line: 2, lineText: 'something else' }), lines)?.text).toBe('  let sum = 0')
  })

  it('gives up when neither the line nor the text exists', () => {
    expect(anchorFinding(finding({ line: 99, lineText: 'nowhere' }), lines)).toBeNull()
    expect(anchorFinding(finding({ side: 'old' }), { old: null, new: lines.new })).toBeNull()
  })
})

describe('toSuggestions', () => {
  it('builds drafts with the title in the body and counts findings it could not place', () => {
    const result = toSuggestions([finding({}), finding({ line: 99, lineText: 'nowhere' })], lines)
    expect(result.unanchored).toBe(1)
    expect(result.drafts).toEqual([
      {
        path: 'src/cart.ts',
        anchor: expect.objectContaining({ line: 3, side: 'new' }),
        severity: 'suggestion',
        title: 'Leftover debug log',
        body: '**Leftover debug log**\n\nRemove it.',
      },
    ])
  })

  it('keys suggestions by anchor and title, ignoring case and spacing in the title', () => {
    const [draft] = toSuggestions([finding({})], lines).drafts
    const same = { ...draft!, title: ' leftover  DEBUG log' }
    expect(suggestionKey(same)).toBe(suggestionKey(draft!))
    expect(suggestionKey({ ...draft!, title: 'Other' })).not.toBe(suggestionKey(draft!))
    expect(suggestionKey({ ...draft!, anchor: { ...draft!.anchor, line: 4 } })).not.toBe(suggestionKey(draft!))
  })
})
