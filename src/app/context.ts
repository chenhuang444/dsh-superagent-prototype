/**
 * Built-in prompt sections, role policies, and transcript projections for orchestrator and worker Sessions.
 * The texts follow the deployment's forge: `prompts/<name>.md` is GitHub's text and the default of every forge, and
 * `prompts/forge/<forge>/<name>.md` takes its place under that forge. `useForgeTexts` selects the forge once, at startup; a
 * deployment has exactly one, so the module-level texts below read as that forge's.
 */
import { existsSync } from 'node:fs'
import { bundledSkills, promptFile } from './skill-files.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ForgeKind } from '../forge/types.ts'
import { packagePath } from '../infra/paths.ts'
export { textPage } from './cards.ts'

/** A prompt file under `forge`: its forge-specific version when one exists, else the shared one. */
export const forgePromptFile = (name: string, forge: ForgeKind): string =>
  forge !== 'github' && existsSync(packagePath('prompts', 'forge', forge, `${name}.md`)) ? promptFile(`forge/${forge}/${name}`) : promptFile(name)

function textsOf(forge: ForgeKind) {
  const file = (name: string) => forgePromptFile(name, forge)
  const handoff = { shared: file('handoff'), orchestrator: file('handoff-orchestrator'), worker: file('handoff-worker') }
  return {
    sharedPrompt: file('shared'), masterPrompt: file('orchestrator'), workerPrompt: file('worker'),
    guides: Object.fromEntries(['subscriptions', 'replies', 'dispatch', 'work'].map(name => [name, file(name)])) as Readonly<Record<string, string>>,
    cliNotes: file('cli'),
    teamDefaults: { communication: file('team/communication'), scope: file('team/scope'), delivery: file('team/delivery') },
    mainAdmissionPolicy: file('admission'),
    handoffPolicy: (role: 'orchestrator' | 'worker'): string => `${handoff.shared}\n${handoff[role]}`,
    /** The Source skills this forge registers: Feishu's and the forge's own. */
    sourceSkills: { feishu: bundledSkills.feishu.content, [forge]: bundledSkills[forge].content } as Readonly<Record<string, string>>,
  }
}
type Texts = ReturnType<typeof textsOf>
const loaded = new Map<ForgeKind, Texts>()
/** The built-in texts of `forge`, read once. */
export const forgeTexts = (forge: ForgeKind): Texts => { let texts = loaded.get(forge); if (!texts) loaded.set(forge, texts = textsOf(forge)); return texts }
let active: ForgeKind = 'github'
/** Selects the forge whose texts the built-in prompts read; the Runtime calls it at startup with the deployment's forge. */
export function useForgeTexts(forge: ForgeKind): void { active = forge; bindTexts() }
/** The forge whose texts the built-in prompts read. */
export const textsForge = (): ForgeKind => active
const current = (): Texts => forgeTexts(active)

/** Built-in host-delivery and tool-usage rules shared by all Sessions; a team may override them (`builtInParts`). */
export let sharedPrompt = current().sharedPrompt
export let masterPrompt = current().masterPrompt
export let workerPrompt = current().workerPrompt
/** Built-in policy sections referenced by role prompts; a team may override them. */
export let guides: Readonly<Record<string, string>> = current().guides
/** Bundled Source skills registered by dsh-superagent; a team may override their text. */
export let sourceSkills: Readonly<Record<string, string>> = current().sourceSkills
export let cliNotes = current().cliNotes
/** Default text for the team-editable prompt sections (communication, ticket scope, and PR delivery). */
export let teamDefaults = current().teamDefaults
export let mainAdmissionPolicy = current().mainAdmissionPolicy
export let handoffPolicy = current().handoffPolicy
/** Rebinds the exported texts to the active forge's; `useForgeTexts` and the prompts module call it. */
export function bindTexts(): void {
  const texts = current()
  ;({ sharedPrompt, masterPrompt, workerPrompt, guides, sourceSkills, cliNotes, teamDefaults, mainAdmissionPolicy, handoffPolicy } = texts)
}

export const autoMergeThreshold = (lines: number): string => `it changes fewer than ${lines} lines (additions plus deletions);`

/** Retains message content while omitting streamed chunks, usage accounting, and reasoning blocks. */
export function transcriptEntry(event: SessionEvent) {
  if (event.type !== 'user/message' && event.type !== 'tool/result' && event.type !== 'assistant/message') return undefined
  const message = event.type === 'user/message' ? event.data : event.data.message
  return { type: event.type, message: { role: message.role, content: message.content.filter(block => block.type !== 'reasoning') } }
}
