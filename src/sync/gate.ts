/** Install commands for the pre-push gate, as shown in Settings. Nothing here runs them. */

export const KEYCHAIN_SERVICE = 'codeducky'

/** Prompts for the token, so it stays out of shell history; -U replaces an older one. */
export const keychainCommand = () => `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "$USER" -w`

export const prePushUrl = (origin: string) => `${origin}/gate/pre-push.sh`
export const claudeHookUrl = (origin: string) => `${origin}/gate/claude-code-hook.sh`

export const installPrePushCommand = (origin: string) =>
  `curl -fsSL ${prePushUrl(origin)} -o .git/hooks/pre-push && chmod +x .git/hooks/pre-push`

export const CLAUDE_HOOK_PATH = '~/.claude/hooks/codeducky-gate.sh'

export const installClaudeHookCommand = (origin: string) =>
  `mkdir -p ~/.claude/hooks && curl -fsSL ${claudeHookUrl(origin)} -o ${CLAUDE_HOOK_PATH} && chmod +x ${CLAUDE_HOOK_PATH}`

/** The PreToolUse entry to merge into ~/.claude/settings.json; the script itself ignores everything but git push. */
export function claudeHookSettings(): string {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: CLAUDE_HOOK_PATH, timeout: 10 }] }],
    },
  }
  return JSON.stringify(settings, null, 2)
}
