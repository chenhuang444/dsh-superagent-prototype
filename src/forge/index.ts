/**
 * The forges a deployment may select, by kind. The GitHub forge is built in; the Gerrit forge adds itself when its module
 * loads, which the main plugin entry imports. Generic code reaches the deployment's forge through `forgeOf(machine.forge)`.
 */
import type { Machine, Probe } from '../deployment.ts'
import type { Settings } from '../policy.ts'
import { githubForge } from './github.ts'
import type { Forge, ForgeKind } from './types.ts'

const FORGES: Partial<Record<ForgeKind, Forge>> = { github: githubForge }
/** Adds a forge; a kind registered twice keeps the latest. */
export function registerForge(forge: Forge): void { FORGES[forge.kind] = forge }
/** The forge of `kind`. @throws when no module registered it */
export function forgeOf(kind: ForgeKind): Forge {
  const forge = FORGES[kind]
  if (!forge) throw new Error(`dsh-superagent has no ${kind} forge`)
  return forge
}
/**
 * Resolves the deployment of `machine.forge` from its Source's configuration (`settings.sources[forge]`); no other Source's
 * accounts are read. @throws SetupError
 */
export function resolveForge(machine: Machine, settings: Settings, probe: Probe, path = process.env.PATH ?? '') {
  const forge = forgeOf(machine.forge)
  return forge.resolve(machine, settings.sources[forge.source]?.config, probe, path)
}
export type { Forge, ForgeAccount, ForgeKind } from './types.ts'
