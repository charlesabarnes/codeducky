import { describe, expect, it } from 'vitest'
import { detectIndent } from '../../src/editor/indent'

describe('detectIndent', () => {
  it('finds tabs', () => {
    expect(detectIndent('func main() {\n\tif x {\n\t\treturn\n\t}\n}\n')).toBe('\t')
  })

  it('finds the space step', () => {
    expect(detectIndent('def f():\n    if x:\n        return 1\n    return 2\n')).toBe('    ')
    expect(detectIndent('const a = {\n  b: {\n    c: 1,\n  },\n}\n')).toBe('  ')
  })

  it('falls back when nothing is indented', () => {
    expect(detectIndent('a\nb\n')).toBe('  ')
  })
})
