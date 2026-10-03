import { GROUP_ORDER, KEYMAP, type KeyBinding, type KeyGroup } from './keymap'
import { formatSequence } from './tokens'

export interface HelpGroup {
  group: KeyGroup
  bindings: KeyBinding[]
}

/** The shortcuts that work right now, grouped for the help overlay. */
export function helpGroups(active: ReadonlySet<string>, bindings: readonly KeyBinding[] = KEYMAP): HelpGroup[] {
  const shown = bindings.filter(
    (binding) => !binding.hidden && (binding.docOnly ? active.has(binding.shownWith ?? '') : active.has(binding.id)),
  )
  return GROUP_ORDER.map((group) => ({ group, bindings: shown.filter((binding) => binding.group === group) })).filter(
    (group) => group.bindings.length > 0,
  )
}

/** Plain text for one binding's keys, e.g. "g then n", "Shift+J", "h or ←". */
export function describeKeys(binding: KeyBinding, mac?: boolean): string {
  return binding.keys
    .map((keys) =>
      formatSequence(keys, mac)
        .map((chord) => chord.join('+'))
        .join(' then '),
    )
    .join(' or ')
}

/** Tooltip text for a control that has a shortcut, e.g. "Notes (g then n)". */
export function withShortcut(label: string, id: string): string {
  const binding = KEYMAP.find((candidate) => candidate.id === id)
  return binding ? `${label} (${describeKeys(binding)})` : label
}
