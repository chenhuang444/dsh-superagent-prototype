/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, GitlabAccount, Machine } from '../../src/deployment.ts'

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
/** The agent's account on `https://gitlab.example.com`, with project `acme/widgets` (id 42). */
export const testGitlab = (overrides: Partial<GitlabAccount> = {}): GitlabAccount => ({
  cli: '/bin/false', url: 'https://gitlab.example.com', host: 'gitlab.example.com', login: 'agent-bot', id: 7, email: 'agent-bot@example.com',
  projectId: 42, identity: 'dedicated', trigger: 'agent', accessLevel: 30, ...overrides,
})
/** A GitLab deployment of project `acme/widgets` on `https://gitlab.example.com`. */
export const testGitlabDeployment = (overrides: Partial<Deployment> & { gitlab?: GitlabAccount } = {}): Deployment => {
  const gitlab = overrides.gitlab ?? testGitlab()
  const { github: _github, ...base } = testDeployment()
  const repository = overrides.repository ?? 'acme/widgets'
  return {
    ...base, forge: 'gitlab', repository, gitlab,
    account: { kind: 'gitlab', login: gitlab.login, email: gitlab.email, repository, web: gitlab.url },
    ...overrides,
  }
}
