import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { DirtyTracker } from '../../src/editor/dirty'

const doc = (text: string) => Text.of(text.split('\n'))

describe('DirtyTracker', () => {
  it('reports dirty on the first edit and clean again when the text is back to the saved one', () => {
    const changes: boolean[] = []
    const tracker = new DirtyTracker(doc('a\nb'), (dirty) => changes.push(dirty))
    tracker.update(doc('a\nbc'))
    tracker.update(doc('a\nbcd'))
    expect(tracker.isDirty).toBe(true)
    tracker.update(doc('a\nb'))
    expect(tracker.isDirty).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('becomes clean after a save of the current text', () => {
    const tracker = new DirtyTracker(doc('a'), () => undefined)
    const edited = doc('ab')
    tracker.update(edited)
    tracker.markSaved(edited, edited)
    expect(tracker.isDirty).toBe(false)
  })

  it('stays dirty when typing went on while the save was in flight', () => {
    const changes: boolean[] = []
    const tracker = new DirtyTracker(doc('a'), (dirty) => changes.push(dirty))
    const saving = doc('ab')
    tracker.update(saving)
    const later = doc('abc')
    tracker.update(later)
    tracker.markSaved(saving, later)
    expect(tracker.isDirty).toBe(true)
    expect(changes).toEqual([true])
  })

  it('takes a reloaded text as the new saved version', () => {
    const tracker = new DirtyTracker(doc('a'), () => undefined)
    tracker.update(doc('mine'))
    const reloaded = doc('theirs')
    tracker.markSaved(reloaded, reloaded)
    expect(tracker.isDirty).toBe(false)
    tracker.update(doc('a'))
    expect(tracker.isDirty).toBe(true)
  })
})
