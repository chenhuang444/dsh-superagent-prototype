/**
 * A GitLab deployment's built-in texts: each file under prompts/forge/gitlab takes the place of the shared file of its name,
 * and what GitLab Sessions read names no GitHub workflow. GitHub's texts are held by tests/github-baseline.spec.ts.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { forgeTexts, useForgeTexts } from '../src/app/context.ts'
import { builtInParts, composePrompt, composeSkill, defaultPrompts, environmentSection, policySection } from '../src/app/prompts.ts'
import { environmentOf } from '../src/app/execution-environment.ts'
import { packagePath } from '../src/infra/paths.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testGitlabDeployment } from './fixtures/deployment.ts'

afterEach(() => { useForgeTexts('github') })
/** The words of GitHub's workflow, which no GitLab text may use. */
const GITHUB_WORDS = /\bgh\b|GitHub|github\.com|pull request|\bPRs?\b|pr_number|DSH_SUPERAGENT_GITHUB|\[bot\]|refs\/pull|noreply\.github/
/** The shared Feishu skill, which every forge reads, names "a related issue or PR" generically; nothing else in it is GitHub's. */
const FEISHU_SHARED = 'creating a related issue or PR'
const githubWord = (text: string): string | undefined => text.replaceAll(FEISHU_SHARED, '').match(GITHUB_WORDS)?.[0]

it('replaces only shared files, each by its own name', () => {
  const root = packagePath('prompts', 'forge', 'gitlab')
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)))
  expect(files.length).toBeGreaterThan(0)
  for (const file of files) expect(existsSync(packagePath('prompts', file)), file).toBe(true)
})

it('gives every built-in part of a GitLab deployment text that names no GitHub workflow', () => {
  const parts = builtInParts('gitlab')
  expect(Object.keys(parts)).toContain('skill/gitlab')
  expect(Object.keys(parts)).not.toContain('skill/github')
  expect(Object.keys(builtInParts('github'))).not.toContain('skill/gitlab')
  for (const [key, part] of Object.entries(parts)) expect(githubWord(part.text), key).toBeUndefined()
  const texts = forgeTexts('gitlab')
  for (const [name, text] of Object.entries(texts.teamDefaults)) expect(githubWord(text), name).toBeUndefined()
  expect(texts.teamDefaults.delivery).toContain('mr merge <iid> --auto-merge --sha <sha> --repo $DSH_SUPERAGENT_GITLAB_URL/$DSH_SUPERAGENT_GITLAB_PROJECT')
  expect(texts.teamDefaults.delivery).toContain('merge_requests/<iid>/cancel_merge_when_pipeline_succeeds')
  expect(texts.teamDefaults.delivery).toContain('public_email')
  // The GitHub texts stay the shared default.
  expect(forgeTexts('github').teamDefaults.delivery).toContain('pr merge <number> --auto --merge')
})

it('gives GitLab Sessions prompts and skills that name no GitHub workflow', () => {
  useForgeTexts('gitlab')
  const settings = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} }, gitlab: { enabled: true, config: {} } } })
  const sources = new SourceRegistry(() => settings)
  // A GitLab profile disables the GitHub plugin, so its kind is not registered.
  sources.register(gitlabKind); sources.register(feishuKind)
  const config = defaultPrompts()
  const environment = environmentSection(config, environmentOf({ deployment: testGitlabDeployment(), sources, settings }))
  const texts = {
    orchestrator: composePrompt(config, 'orchestrator', environment, policySection(settings, config)),
    worker: composePrompt(config, 'worker', environment),
    gitlab: composeSkill(config, 'gitlab'),
    feishu: composeSkill(config, 'feishu'),
  }
  for (const [name, text] of Object.entries(texts)) expect(githubWord(text), name).toBeUndefined()
  expect(texts.feishu).toContain(FEISHU_SHARED)
  expect(texts.worker).toContain('mr_number')
  expect(texts.worker).toContain('$DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL')
  expect(texts.worker).toContain('DSH_SUPERAGENT_GITLAB_PROJECT_ID')
  // Workers write to GitLab only through the host's tools, which sign and mark what they post.
  expect(texts.gitlab).toContain('call gitlab_reply with kind mr')
  expect(texts.gitlab).not.toMatch(/glab api -X (POST|PUT)/)
  expect(texts.worker).toContain('write to it only with the gitlab_* tools')
  expect(texts.worker).not.toMatch(/glab (api -X|mr (note|create|update|close))/)
  expect(texts.worker).toContain('never use git push options')
  expect(composeSkill(config, 'github')).toBe('')
})
