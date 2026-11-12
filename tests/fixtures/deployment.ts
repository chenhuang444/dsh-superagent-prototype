/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, GerritAccount, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), forge: 'github', ...overrides,
})
/** A GitHub deployment; `account` follows `github` and `repository` unless an override names it. */
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => {
  const github = overrides.github ?? { cli: '/bin/false', login: 'agent-bot', noreply: '7+agent-bot@users.noreply.github.com' }
  const repository = overrides.repository ?? 'acme/widgets'
  return {
    ...testMachine(), repository, github,
    account: { kind: 'github', login: github.login, email: github.noreply, repository, web: 'https://github.com' },
    feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' },
    ...overrides,
  }
}
export const testGerrit = (overrides: Partial<GerritAccount> = {}): GerritAccount => ({
  url: 'https://gerrit.example.com', project: 'widgets', netrc: '/tmp/dsh-superagent-test/netrc', id: 1000042, username: 'agent-bot',
  email: 'agent-bot@example.com', ...overrides,
})
/** A Gerrit deployment of project `widgets` on `https://gerrit.example.com`. */
export const testGerritDeployment = (overrides: Partial<Deployment> & { gerrit?: GerritAccount } = {}): Deployment => {
  const gerrit = overrides.gerrit ?? testGerrit()
  const { github: _github, ...base } = testDeployment()
  return {
    ...base, forge: 'gerrit', repository: gerrit.project, gerrit,
    account: { kind: 'gerrit', login: gerrit.username, email: gerrit.email, repository: gerrit.project, web: gerrit.url },
    ...overrides,
  }
}
