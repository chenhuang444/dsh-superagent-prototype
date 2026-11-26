/** GitLab identities of the agent account `agent-bot`: its own account, and a person's own account it shares. */
import type { GitlabIdentity } from '../../src/sources/gitlab-identity.ts'

export const AGENT: GitlabIdentity = { login: 'agent-bot', identity: 'dedicated', trigger: 'agent' }
export const PERSONAL: GitlabIdentity = { login: 'agent-bot', identity: 'personal', trigger: 'agent' }
