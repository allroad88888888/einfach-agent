import { atom, type Getter, type Setter } from '@einfach/core'

export interface LatestOnlyLoader<Key = undefined> {
  start(get: Getter, set: Setter, key?: Key): number
  isLatest(get: Getter, token: number, key?: Key): boolean
}

/** Issues per-store request tokens so only the newest request for a scope can commit. */
export function createLatestOnlyLoader<Key = undefined>(): LatestOnlyLoader<Key> {
  const requestTokensAtom = atom<Map<Key | undefined, number>>(new Map())
  return {
    start(get, set, key) {
      const requestTokens = get(requestTokensAtom)
      const token = (requestTokens.get(key) ?? 0) + 1
      set(requestTokensAtom, new Map(requestTokens).set(key, token))
      return token
    },
    isLatest(get, token, key) {
      return get(requestTokensAtom).get(key) === token
    },
  }
}
