import type { ResolvedHost } from './resolveHost'
import { createServerModelConnectionProfileHost } from '../settings/serverModelConnectionProfileHost'
import {
  createUnavailableModelConnectionProfileHost,
  type ModelConnectionProfileHost,
} from '../settings/modelConnectionProfileHost'

/** Selects profile CRUD from the same resolved host predicate used by model transport. */
export function createHostModelConnectionProfileHost(
  host: ResolvedHost,
): ModelConnectionProfileHost {
  if (host.kind === 'server') return createServerModelConnectionProfileHost()
  return createUnavailableModelConnectionProfileHost()
}
