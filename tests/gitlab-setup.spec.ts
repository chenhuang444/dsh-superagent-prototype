import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Config, machineOf, resolveGitlab, setupFields, type Probe } from '../src/deployment.ts'

let dir: string
let path: string
let cli: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitlab-setup-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true })
  cli = join(dir, 'bin', 'glab')
  for (const file of [cli, join(dir, 'state', 'worker-bin', 'glab')]) { writeFileSync(file, '#!/bin/sh\nexit 1\n'); chmodSync(file, 0o755) }
  // The stale worker shim comes first on PATH and must be skipped.
  path = [join(dir, 'state', 'worker-bin'), join(dir, 'bin')].join(':')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const machine = () => machineOf(Config({ stateDir: join(dir, 'state'), forge: 'gitlab' }))
const USER = { id: 7, username: 'agent-bot', email: 'agent-bot@example.com', commit_email: 'agent-bot@users.example.com', public_email: null }
const PROJECT = { id: 42, path_with_namespace: 'acme/widgets', default_branch: 'main',
  permissions: { project_access: { access_level: 30 }, group_access: null } }
/** A fake probe answering `glab api --hostname <host> <endpoint>` from `answers`; a missing answer fails like glab does. */
const fake = (answers: Record<string, unknown>, calls: string[][] = []): Probe => async argv => {
  calls.push(argv)
  const [program, api, flag, host, endpoint, ...rest] = argv
  if (program !== cli || api !== 'api' || flag !== '--hostname' || rest.length) throw new Error(`unexpected ${argv.join(' ')}`)
  const answer = answers[`${host} ${endpoint}`]
  if (answer === undefined) throw new Error('glab: 404 Not Found (HTTP 404)')
  return typeof answer === 'string' ? answer : JSON.stringify(answer)
}
const answers = (overrides: Record<string, unknown> = {}) =>
  ({ 'gitlab.example.com user': USER, 'gitlab.example.com projects/acme%2Fwidgets': PROJECT, ...overrides })
const config = { url: 'https://gitlab.example.com', project: 'acme/widgets', cli: 'glab' }
const fails = (code: string, values: Record<string, unknown>, settings: unknown, probe = fake(answers())) =>
  expect(resolveGitlab(machine(), settings, probe, path)).rejects.toMatchObject({ place: 'gitlab', code, values: expect.objectContaining(values) })

describe('GitLab setup', () => {
  it('reads the agent\'s account and the project through the configured host, skipping the worker shims', async () => {
    const calls: string[][] = []
    const deployment = await resolveGitlab(machine(), config, fake(answers(), calls), path)
    expect(calls).toEqual([[cli, 'api', '--hostname', 'gitlab.example.com', 'user'], [cli, 'api', '--hostname', 'gitlab.example.com', 'projects/acme%2Fwidgets']])
    expect(deployment).toMatchObject({ forge: 'gitlab', repository: 'acme/widgets',
      gitlab: { cli, url: 'https://gitlab.example.com', host: 'gitlab.example.com', login: 'agent-bot', id: 7, email: 'agent-bot@users.example.com', projectId: 42 },
      account: { kind: 'gitlab', login: 'agent-bot', email: 'agent-bot@users.example.com', repository: 'acme/widgets', web: 'https://gitlab.example.com' } })
    expect(deployment).not.toHaveProperty('github')
    expect(setupFields('gitlab')).toEqual({ gitlab: ['url', 'project', 'cli'], feishu: ['cli'] })
  })
  it('keeps the port in the host glab is asked for, and uses the project\'s canonical path and a subgroup', async () => {
    const moved = { ...PROJECT, path_with_namespace: 'acme/platform/widgets' }
    const deployment = await resolveGitlab(machine(), { ...config, url: 'https://gitlab.example.com:8443', project: 'acme/platform/old-widgets' },
      fake({ 'gitlab.example.com:8443 user': USER, 'gitlab.example.com:8443 projects/acme%2Fplatform%2Fold-widgets': moved }), path)
    expect(deployment.repository).toBe('acme/platform/widgets')
    expect(deployment.gitlab).toMatchObject({ url: 'https://gitlab.example.com:8443', host: 'gitlab.example.com:8443' })
  })
  it('takes the commit email, else the account\'s email, else the server\'s noreply address without the port', async () => {
    const email = async (user: object, url = 'https://gitlab.example.com:8443') => {
      const { host } = new URL(url)
      return (await resolveGitlab(machine(), { ...config, url }, fake({ [`${host} user`]: { ...USER, ...user }, [`${host} projects/acme%2Fwidgets`]: PROJECT }), path)).account.email
    }
    expect(await email({})).toBe('agent-bot@users.example.com')
    expect(await email({ commit_email: '' })).toBe('agent-bot@example.com')
    expect(await email({ commit_email: null, email: undefined })).toBe('7-agent-bot@users.noreply.gitlab.example.com')
  })
  it('accepts Developer access from the project or its group, whichever is higher', async () => {
    const access = (project_access: object | null, group_access: object | null) =>
      resolveGitlab(machine(), config, fake(answers({ 'gitlab.example.com projects/acme%2Fwidgets': { ...PROJECT, permissions: { project_access, group_access } } })), path)
    await expect(access(null, { access_level: 40 })).resolves.toMatchObject({ repository: 'acme/widgets' })
    await expect(access({ access_level: 20 }, { access_level: 30 })).resolves.toMatchObject({ repository: 'acme/widgets' })
    await expect(access({ access_level: 20 }, { access_level: 10 })).rejects.toMatchObject({ code: 'gitlabProjectReadOnly' })
    await expect(access(null, null)).rejects.toMatchObject({ code: 'gitlabProjectReadOnly' })
  })
  it('names what setup needs, in order, and where it is set', async () => {
    await fails('gitlabUrlUnset', {}, { project: 'acme/widgets', cli: 'glab' })
    await fails('gitlabProjectUnset', {}, { url: config.url, cli: 'glab' })
    await fails('gitlabCliUnset', {}, { url: config.url, project: config.project })
    await fails('gitlabCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { ...config, cli: join(dir, 'missing') })
    await fails('gitlabCliMissing', { output: 'bin/glab must be a command name or an absolute path' }, { ...config, cli: 'bin/glab' })
    await fails('gitlabCliSignedOut', { host: 'gitlab.example.com', output: 'glab: 404 Not Found (HTTP 404)' }, config, fake(answers({ 'gitlab.example.com user': undefined })))
    await fails('gitlabNoAccount', { host: 'gitlab.example.com' }, config, fake(answers({ 'gitlab.example.com user': 'not json' })))
    await fails('gitlabNoAccount', {}, config, fake(answers({ 'gitlab.example.com user': { id: 7 } })))
    await fails('gitlabProjectUnreadable', { account: 'agent-bot', project: 'acme/widgets', output: 'glab: 404 Not Found (HTTP 404)' }, config,
      fake(answers({ 'gitlab.example.com projects/acme%2Fwidgets': undefined })))
    await fails('gitlabProjectUnreported', { project: 'acme/widgets' }, config, fake(answers({ 'gitlab.example.com projects/acme%2Fwidgets': { id: 42 } })))
    await fails('gitlabProjectReadOnly', { account: 'agent-bot', project: 'acme/widgets' }, config,
      fake(answers({ 'gitlab.example.com projects/acme%2Fwidgets': { ...PROJECT, permissions: { project_access: { access_level: 20 }, group_access: null } } })))
  })
  it('refuses an address with a path or trailing slash and a project without a group', async () => {
    for (const url of ['http://gitlab.example.com', 'https://gitlab.example.com/', 'https://gitlab.example.com/gitlab', 'gitlab.example.com']) {
      await expect(resolveGitlab(machine(), { ...config, url }, fake(answers()), path)).rejects.toThrow('https://host[:port]')
    }
    for (const project of ['widgets', 'acme/', '/acme/widgets', 'acme/wid gets']) {
      await expect(resolveGitlab(machine(), { ...config, project }, fake(answers()), path)).rejects.toThrow('group/name')
    }
  })
})
