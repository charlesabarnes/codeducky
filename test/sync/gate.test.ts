import { describe, expect, it } from 'vitest'
import { checklistsToJson, parseChecklistJson } from '../../src/checklists/format'
import { claudeHookSettings, installClaudeHookCommand, installPrePushCommand, keychainCommand } from '../../src/sync/gate'
import { validateChange } from '../../shared/sync'

describe('pre-push gate setup commands', () => {
  it('installs the hook from this server and reads the token from the Keychain item', () => {
    expect(installPrePushCommand('https://skel.example')).toBe(
      'curl -fsSL https://skel.example/gate/pre-push.sh -o .git/hooks/pre-push && chmod +x .git/hooks/pre-push',
    )
    expect(keychainCommand()).toBe('security add-generic-password -U -s skelbert -a "$USER" -w')
    expect(installClaudeHookCommand('https://skel.example')).toContain('https://skel.example/gate/claude-code-hook.sh')
  })

  it('gives a PreToolUse Bash hook for Claude Code settings', () => {
    expect(JSON.parse(claudeHookSettings())).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/skelbert-gate.sh', timeout: 10 }] }] },
    })
  })
})

describe('required checklists', () => {
  it('keeps the flag through JSON export and import', () => {
    const json = checklistsToJson([{ title: 'Before push', items: ['Tests pass'], required: true }, { title: 'Other', items: ['x'] }])
    expect(parseChecklistJson(json)).toEqual([{ title: 'Before push', items: ['Tests pass'], required: true }, { title: 'Other', items: ['x'] }])
  })

  it('syncs the flag and repo instructions, and refuses wrong types', () => {
    const list = { scope: 'global', title: 't', items: [] }
    expect(validateChange({ kind: 'checklists', id: 'c', changedAt: 1, deleted: false, data: { ...list, required: true } })).toBeNull()
    expect(validateChange({ kind: 'checklists', id: 'c', changedAt: 1, deleted: false, data: { ...list, required: 'yes' } })).toBe('checklists.required is invalid')
    const repo = { owner: 'o', name: 'r', folderName: 'r', baseBranch: 'main', lastOpenedAt: 1 }
    expect(validateChange({ kind: 'repos', id: 'gh:o/r', changedAt: 1, deleted: false, data: { ...repo, instructions: 'x' } })).toBeNull()
    expect(validateChange({ kind: 'repos', id: 'gh:o/r', changedAt: 1, deleted: false, data: { ...repo, instructions: 3 } })).toBe('repos.instructions is invalid')
  })
})
