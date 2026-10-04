import { describe, expect, it } from 'vitest'
import { claudeDeepLink, customPrompt, linkPrompt, MAX_PROMPT, type LinkTarget } from '../../src/channel/deepLink'

const branch: LinkTarget = { repo: 'acme/invoice-service', branch: 'feature/tax-rounding' }
const pull: LinkTarget = { repo: 'acme/invoice-service', branch: 'fix/webhooks', pr: { number: 42, headRef: 'fix/webhooks' } }

/** Reads a deep link back the way a URL parser would. */
function parse(link: string) {
  const url = new URL(link)
  return { scheme: url.protocol, host: url.host, repo: url.searchParams.get('repo'), q: url.searchParams.get('q') }
}

describe('Claude Code deep links', () => {
  it('builds the documented claude-cli://open URL with repo and q', () => {
    const link = claudeDeepLink('acme/payments', 'review open PRs')
    expect(link).toBe('claude-cli://open?repo=acme/payments&q=review%20open%20PRs')
    expect(parse(link)).toEqual({ scheme: 'claude-cli:', host: 'open', repo: 'acme/payments', q: 'review open PRs' })
  })

  it('percent-encodes line breaks, ampersands and quotes so the prompt survives intact', () => {
    const prompt = 'Line one & "two"\nLine #3 100%'
    const link = claudeDeepLink('acme/app', prompt)
    expect(link).toContain('%0A')
    expect(link).not.toMatch(/[\s"#]/)
    expect(parse(link).q).toBe(prompt)
  })

  it('caps q at the documented 5,000 characters', () => {
    expect(parse(claudeDeepLink('acme/app', 'x'.repeat(6000))).q).toHaveLength(MAX_PROMPT)
  })

  it('names the Skelbert prompts, tools, repo and branch for a branch session', () => {
    const review = linkPrompt('review', branch)
    expect(review).toContain('/mcp__skelbert__review acme/invoice-service feature/tax-rounding')
    expect(review).toContain('get_review_context with repo "acme/invoice-service" and branch "feature/tax-rounding"')
    expect(review).toContain('add_note')
    const fix = linkPrompt('fix', branch)
    expect(fix).toContain('/mcp__skelbert__fix acme/invoice-service feature/tax-rounding')
    expect(fix).toContain('resolve_note')
    expect(fix).toContain('Never push')
  })

  it('selects pull request sessions by number', () => {
    expect(linkPrompt('review', pull)).toContain('get_review_context with repo "acme/invoice-service" and pr 42')
    expect(linkPrompt('review', pull)).toContain('gh pr diff 42')
    expect(linkPrompt('fix', pull)).toContain('head branch fix/webhooks')
  })

  it('adds the Skelbert context to a custom prompt and keeps it under the cap', () => {
    const prompt = customPrompt('  Why is rounding done twice?  ', branch)
    expect(prompt).toMatch(/^Why is rounding done twice\?\n\n\(Context: my Skelbert review of branch feature\/tax-rounding/)
    expect(customPrompt('y'.repeat(9000), pull).length).toBeLessThanOrEqual(MAX_PROMPT)
    expect(customPrompt('y'.repeat(9000), pull)).toContain('pr 42')
  })
})
