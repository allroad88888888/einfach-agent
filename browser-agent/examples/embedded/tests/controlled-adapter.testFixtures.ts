import { createDomPageHost, type ControlledFieldAdapter } from '@einfach-agent/tools-browser-page'

declare global { interface Window { runControlledAdapterCancel(): Promise<unknown> } }

window.runControlledAdapterCancel = async () => {
  const element = document.createElement('div')
  element.dataset.controlled = 'true'
  element.textContent = 'before'
  document.body.append(element)
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const releasePromise = new Promise<void>((resolve) => { release = resolve })
  let lateWrite = false
  const adapter: ControlledFieldAdapter = {
    kind: 'slow-controlled',
    matches: (candidate) => candidate === element,
    read: (candidate) => ({ label: 'Slow controlled', value: candidate.textContent ?? '', required: false, readOnly: false, supported: true }),
    async write(candidate, value, ctx) {
      entered()
      await releasePromise
      if (ctx.signal.aborted) return
      lateWrite = true
      candidate.textContent = String(value)
    },
  }
  const host = createDomPageHost({ document, targetId: 'adapter-fixture', documentId: 'adapter-document', controlledAdapters: [adapter] })
  const snapshot = await host.readForm({ sessionId: 'adapter-session', signal: new AbortController().signal })
  const controller = new AbortController()
  const filling = host.fillFields({ page: snapshot.page, values: [{ id: snapshot.fields[0].id, value: 'after' }] }, { sessionId: 'adapter-session', signal: controller.signal })
  await enteredPromise
  controller.abort()
  release()
  let outcomes: unknown
  let error: string | undefined
  try { outcomes = await filling } catch (reason) { error = reason instanceof Error ? reason.name : String(reason) }
  return { entered: true, aborted: controller.signal.aborted, lateWrite, value: element.textContent, outcomes, error }
}
