/**
 * Regression baseline for a GitHub deployment: what the models read (every built-in prompt part, both roles' prompts, the
 * skills, the Executor's tool schemas) and what a ticket's execution environment holds. Making the code host pluggable must
 * keep a GitHub deployment's text and values exactly as they were; the snapshots in __snapshots__ hold them.
 */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { builtInParts, composePrompt, composeSkill, defaultPrompts, environmentSection, policySection } from '../src/app/prompts.ts'
import { environmentLines, environmentOf } from '../src/app/execution-environment.ts'
import { executorTools, type ExecutorToolsHost } from '../src/app/tools/executor.ts'
import type { Ticket, Trigger } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { testDeployment } from './fixtures/deployment.ts'

const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} } } })
const registry = () => {
  const sources = new SourceRegistry(() => settings)
  sources.register(githubKind); sources.register(feishuKind)
  return sources
}
const ticket = { id: 'tk_0123456789abcdef', name: 'fix-dates', directory: '/work/fix-dates-tk_0123456789' }
const trigger = (source: string, meta: Record<string, unknown>, thread: string): Trigger => ({ id: 'tr_1', source, threads: [{ source, id: thread }],
  actor: { source, id: 'alice' }, human: true, at: '2026-01-01T00:00:00.000Z', text: 'x', meta })
const values = (input: Trigger | undefined) => Object.fromEntries(environmentOf({ deployment: testDeployment(), sources: registry(), settings, ticket,
  ...input ? { trigger: input } : {} }).map(variable => [variable.key, variable.value]))

it('keeps every built-in part of a GitHub deployment as it was', () => {
  const parts = Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, { roles: part.roles, text: part.text, placeholders: part.placeholders ?? [] }]))
  expect(parts).toMatchSnapshot()
})

it('keeps both roles\' prompts and the skills of a GitHub deployment as they were', () => {
  const config = defaultPrompts()
  const variables = environmentOf({ deployment: testDeployment(), sources: registry(), settings })
  const environment = environmentSection(config, variables)
  expect(environmentLines(variables)).toMatchSnapshot('environment outside a ticket')
  expect(composePrompt(config, 'orchestrator', environment, policySection(settings, config))).toMatchSnapshot('orchestrator')
  expect(composePrompt(config, 'worker', environment)).toMatchSnapshot('worker')
  expect({ github: composeSkill(config, 'github'), feishu: composeSkill(config, 'feishu') }).toMatchSnapshot('skills')
})

it('keeps the execution environment of GitHub Issue, PR and Feishu tickets as it was', () => {
  expect(values(trigger('github', { number: 12, isPr: false, kind: 'issue' }, '12'))).toMatchSnapshot('issue')
  expect(values(trigger('github', { number: 34, isPr: true, kind: 'pull' }, '34'))).toMatchSnapshot('pull request')
  expect(values(trigger('feishu', { chatId: 'oc_chat' }, 'oc_chat:om_root'))).toMatchSnapshot('feishu')
  expect(values(undefined)).toMatchSnapshot('no trigger')
})

it('keeps the Executor tools a GitHub deployment registers as they were', () => {
  const github = { deployment: testDeployment() } as unknown as SourceContext
  const host = { github } as unknown as ExecutorToolsHost
  const tools = executorTools(host, { id: ticket.id } as Ticket)
  expect(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.schema) }))).toMatchSnapshot()
})
