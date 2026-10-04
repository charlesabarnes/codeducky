import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const GATE_SCRIPTS = ['pre-push.sh', 'claude-code-hook.sh'] as const
export type GateScript = (typeof GATE_SCRIPTS)[number]

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8')
const COMMON = read('common.sh')
const SOURCES = Object.fromEntries(GATE_SCRIPTS.map((name) => [name, read(name)])) as Record<GateScript, string>

export const isGateScript = (name: string): name is GateScript => (GATE_SCRIPTS as readonly string[]).includes(name)

/** A hook script with the shared helpers inlined and this server's origin as the default URL. */
export function renderScript(name: GateScript, origin: string): string {
  const url = new URL(origin).origin.replace(/'/g, '')
  return SOURCES[name].replace('# @common\n', COMMON).replace('__CODEDUCKY_URL__', url)
}
