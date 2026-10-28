import type { PageCallContext, PageRef } from '@einfach-agent/tools-browser-page'

export type { PageCallContext, PageRef }

export interface DomNode {
  ref: string
  parentRef?: string
  tag: string
  role?: string
  name: string
  text?: string
  value?: string
  disabled?: boolean
  readOnly?: boolean
  expanded?: boolean
  selected?: boolean
  checked?: boolean
  attributes?: Record<string, string>
}

export interface ReadDomInput {
  page?: PageRef
  scopeRef?: string
  selector?: string
  text?: string
  offset?: number
  limit?: number
}

export interface DomSnapshot {
  page: PageRef
  nodes: readonly DomNode[]
  truncated: boolean
  nextOffset?: number
}

export interface DomTargetInput { page: PageRef; ref: string }
export interface TypeDomInput extends DomTargetInput { text: string }
export interface PressDomKeyInput extends DomTargetInput { key: string }
export interface ScrollDomInput extends DomTargetInput { direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
export interface WaitForDomInput extends ReadDomInput { page: PageRef; condition?: 'present' | 'absent'; timeoutMs?: number }
export interface DomActionResult { page: PageRef; ref: string; dispatched: true; node?: DomNode }

export interface DomToolsHost {
  readDom(input: ReadDomInput, ctx: PageCallContext): Promise<DomSnapshot>
  clickDom(input: DomTargetInput, ctx: PageCallContext): Promise<DomActionResult>
  typeDom(input: TypeDomInput, ctx: PageCallContext): Promise<DomActionResult>
  pressDomKey(input: PressDomKeyInput, ctx: PageCallContext): Promise<DomActionResult>
  scrollDom(input: ScrollDomInput, ctx: PageCallContext): Promise<DomActionResult>
  waitForDom(input: WaitForDomInput, ctx: PageCallContext): Promise<DomSnapshot>
}

export interface DomToolsHostOptions {
  document: Document
  targetId: string
  documentId?: string
  revision?: number
}
