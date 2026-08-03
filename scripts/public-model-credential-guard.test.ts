import { describe, expect, it } from 'vitest'
import { assertNoPublicModelCredentials } from './public-model-credential-guard'

describe('assertNoPublicModelCredentials', () => {
  it('allows server-only model credentials', () => {
    expect(() => assertNoPublicModelCredentials({
      DEEPSEEK_API_KEY: 'server-only-sentinel',
      GLM_API_KEY: 'server-only-sentinel',
    })).not.toThrow()
  })

  it('rejects every populated Vite-exposed model credential without rendering its value', () => {
    const credential = 'must-not-appear-in-browser'
    const invokeGuard = () => assertNoPublicModelCredentials({
      VITE_DEEPSEEK_API_KEY: credential,
      VITE_GLM_API_KEY: credential,
    })
    expect(invokeGuard).toThrow('VITE_DEEPSEEK_API_KEY, VITE_GLM_API_KEY')
    try {
      invokeGuard()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).not.toContain(credential)
    }
  })

  it('allows an empty legacy variable so local tooling can clear it during migration', () => {
    expect(() => assertNoPublicModelCredentials({ VITE_DEEPSEEK_API_KEY: '   ' })).not.toThrow()
  })
})
