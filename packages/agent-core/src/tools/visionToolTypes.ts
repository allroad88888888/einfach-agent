/** Value objects shared by confined image reads and app-owned vision calls. */
export type WorkspaceImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp'

export interface WorkspaceImageReadInput {
  path: string
  maxBytes?: number
  workspaceRoot?: string
  /** Runtime-only permission derived from the session; tool schemas must not expose it. */
  allowExternalPaths?: boolean
}

export interface WorkspaceImageReadResult {
  base64: string
  mimeType: WorkspaceImageMimeType
  filename: string
  sizeBytes: number
}

export interface ViewImageInput {
  path: string
  detail: 'low' | 'high'
}

export interface ViewImageResult {
  content: string
  model: string
}

/** The deliberately narrow core surface exposed to the app-owned vision implementation. */
export interface ViewImageCapabilityContext {
  readonly signal: AbortSignal
  assertFresh(): void
  readWorkspaceImage(input: WorkspaceImageReadInput): Promise<WorkspaceImageReadResult>
}

export type ViewImageCapability = (
  input: ViewImageInput,
  context: ViewImageCapabilityContext,
) => Promise<ViewImageResult>
