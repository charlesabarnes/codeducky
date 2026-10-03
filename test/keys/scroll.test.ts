import { describe, expect, it } from 'vitest'
import { scrollDelta } from '../../src/keys/scroll'

const view = { top: 100, bottom: 900 } // 800 tall, margin 160

describe('scrollDelta', () => {
  it('leaves a comfortably visible row alone', () => {
    expect(scrollDelta({ top: 400, bottom: 420 }, view, 'nearest')).toBe(0)
    expect(scrollDelta({ top: 400, bottom: 420 }, view, 'center')).toBe(0)
  })

  it('scrolls only as far as needed for small steps', () => {
    expect(scrollDelta({ top: 730, bottom: 750 }, view, 'nearest')).toBe(10)
    expect(scrollDelta({ top: 250, bottom: 270 }, view, 'nearest')).toBe(-10)
  })

  it('puts jump targets a third of the way down', () => {
    expect(scrollDelta({ top: 2000, bottom: 2020 }, view, 'center')).toBe(2000 - (100 + 800 / 3))
  })

  it('never scrolls in none mode', () => {
    expect(scrollDelta({ top: 2000, bottom: 2020 }, view, 'none')).toBe(0)
  })
})
