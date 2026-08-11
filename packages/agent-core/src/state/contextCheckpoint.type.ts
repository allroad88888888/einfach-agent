/** A model-authored, durable projection of the covered conversation prefix. */
export interface ContextCheckpoint {
  schemaVersion: 1
  summary: string
  coveredItemIds: string[]
  createdAt: number
  sourceEstimatedTokens: number
}
