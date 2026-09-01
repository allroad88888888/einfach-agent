/** Marks failures that can only originate in the disposable search projection. */
export class DerivedSearchIndexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DerivedSearchIndexError'
  }
}

/** Marks a JOIN/MATCH SQL failure whose owning table must be diagnosed by the facade probe. */
export class MixedSearchIndexSqlError extends Error {
  constructor(cause: unknown) {
    super('Mixed canonical/search SQL failed', { cause })
    this.name = 'MixedSearchIndexSqlError'
  }
}

export function derivedSearchFailure(message: string, cause?: unknown): DerivedSearchIndexError {
  return new DerivedSearchIndexError(message, cause === undefined ? undefined : { cause })
}

export function isDerivedSearchFailure(error: unknown): error is DerivedSearchIndexError {
  return error instanceof DerivedSearchIndexError
}
