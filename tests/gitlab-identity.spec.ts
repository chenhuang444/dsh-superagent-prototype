import { expect, it } from 'vitest'
import { addressesAgent, byAgent, byOwner, forOwnerOnly, marked, markerOf, ownWords, signedBody, summons }
  from '../src/sources/gitlab-identity.ts'
import { AGENT, PERSONAL } from './fixtures/gitlab-identity.ts'

it('finds the trigger word at a line start, after mentions, in any case and with either colon', () => {
  for (const text of ['agent: set the gap', '@lisi agent: set the gap', '@lisi @wangwu, agent：改一下', 'Agent : fix',
    'first paragraph\n\nagent: also the button', '  agent: indented a little', '@a.b-c、agent: x'])
    expect(summons(text, 'agent'), text).toBe(true)
})

it('does not count the trigger word inside prose, names, quotes, code or comments', () => {
  for (const text of ['this agent: is wrong', '@build-agent: ping', '@ciagent：hi', '> agent: quoted', '>quoted\nagent: lazy continuation',
    '```\nagent: in a fence\n```', '~~~yaml\nagent: x\n~~~', '    agent: indented code', '`agent:` in code', '>>>\nagent: quote block\n>>>',
    '<!-- agent: hidden -->', '<details>\nagent: folded\n</details>', 'agentx: other word', 'agent no colon'])
    expect(summons(text, 'agent'), text).toBe(false)
  expect(summons('agent: x', '')).toBe(false)
})

it('quotes of the signature, which names the trigger word in code, do not address the agent', () => {
  const body = signedBody(PERSONAL, 'm1', '已改好。', '改一下')
  expect(summons(body, 'agent')).toBe(false)
  expect(summons(`> ${body.split('\n').join('\n> ')}\n\nthanks`, 'agent')).toBe(false)
})

it('keeps the words a person wrote: text after a closed fence and after a blank line that ends a quote', () => {
  expect(ownWords('```\ncode\n```\nagent: after')).toContain('agent: after')
  expect(summons('> quoted\n\nagent: after', 'agent')).toBe(true)
})

it('tells the agent from the person under personal by the marker, and by the account under dedicated', () => {
  const signed = signedBody(PERSONAL, 'm1', 'Done.')
  expect(marked(signed)).toBe(true)
  expect(signed).toContain(markerOf('m1'))
  expect(signed).toContain('DSH superagent')
  expect(byAgent('Agent-Bot', signed, PERSONAL)).toBe(true)
  expect(byAgent('agent-bot', 'my own words', PERSONAL)).toBe(false)
  expect(byOwner('agent-bot', 'my own words', PERSONAL)).toBe(true)
  // Another person pasting the marker is still that person.
  expect(byAgent('carol', signed, PERSONAL)).toBe(false)
  expect(byAgent('agent-bot', 'anything', AGENT)).toBe(true)
  expect(byOwner('agent-bot', 'anything', AGENT)).toBe(false)
})

it('signs in the language of the request, without mentioning the account, and only under personal', () => {
  expect(signedBody(PERSONAL, 'm1', '好的', '把间距改成 8px')).toContain('代 agent-bot 发出')
  expect(signedBody(PERSONAL, 'm1', 'OK', 'fix the gap')).toContain('on behalf of agent-bot')
  expect(signedBody(PERSONAL, 'm1', 'OK')).not.toMatch(/@agent-bot\b/)
  expect(signedBody(AGENT, 'm1', 'OK')).toBe(`OK\n\n${markerOf('m1')}`)
})

it('addresses the agent by @login when dedicated and by the trigger word when personal', () => {
  expect(addressesAgent('@agent-bot fix', AGENT)).toBe(true)
  expect(addressesAgent('agent: fix', AGENT)).toBe(false)
  expect(addressesAgent('@agent-bot fix', PERSONAL)).toBe(false)
  expect(addressesAgent('@agent-bot agent: fix', PERSONAL)).toBe(true)
  expect(forOwnerOnly('@agent-bot 你看下', PERSONAL)).toBe(true)
  expect(forOwnerOnly('@agent-bot agent: 改一下', PERSONAL)).toBe(false)
  expect(forOwnerOnly('`@agent-bot` in code', PERSONAL)).toBe(false)
  expect(forOwnerOnly('@agent-bot 你看下', AGENT)).toBe(false)
})
