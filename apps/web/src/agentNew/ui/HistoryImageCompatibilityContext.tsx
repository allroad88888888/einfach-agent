import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  projectHistoryImage,
  type HistoryImageProjection,
  type HistoryImageTarget,
  type UserImageContentBlock,
} from '@web-agent/ai'

const defaultTarget: HistoryImageTarget = { vendor: '', model: '' }
const HistoryImageTargetContext = createContext<HistoryImageTarget>(defaultTarget)

export function HistoryImageCompatibilityProvider({
  children,
  vendor,
  model,
  region,
}: HistoryImageTarget & { children: ReactNode }) {
  const target = useMemo(() => ({ vendor, model, region }), [vendor, model, region])
  return (
    <HistoryImageTargetContext.Provider value={target}>
      {children}
    </HistoryImageTargetContext.Provider>
  )
}

export function useHistoryImageTarget(): HistoryImageTarget {
  return useContext(HistoryImageTargetContext)
}

export function useHistoryImageProjection(
  image: UserImageContentBlock,
): HistoryImageProjection {
  return projectHistoryImage(image, useHistoryImageTarget())
}
