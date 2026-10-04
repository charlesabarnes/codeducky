import type { Text } from '@codemirror/state'

/** Compares the document with the last saved one and reports only when the answer changes. */
export class DirtyTracker {
  private saved: Text
  private dirty = false
  private readonly onChange: (dirty: boolean) => void

  constructor(saved: Text, onChange: (dirty: boolean) => void) {
    this.saved = saved
    this.onChange = onChange
  }

  get isDirty(): boolean {
    return this.dirty
  }

  update(doc: Text): void {
    const next = !doc.eq(this.saved)
    if (next === this.dirty) return
    this.dirty = next
    this.onChange(next)
  }

  /** `saved` is what was written, which may be older than `current` when typing went on during the save. */
  markSaved(saved: Text, current: Text): void {
    this.saved = saved
    this.update(current)
  }
}
