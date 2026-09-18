const tails = new WeakMap<Document, Promise<void>>()

export function enqueueDocumentWrite<T>(document: Document, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(document) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(operation)
  const tail = result.then(() => undefined, () => undefined)
  tails.set(document, tail)
  void tail.finally(() => { if (tails.get(document) === tail) tails.delete(document) })
  return result
}
