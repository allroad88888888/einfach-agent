import { definePackageBuild } from '../../tsup.preset'

export default definePackageBuild({
  entry: ['src/index.ts'],
  external: [],
})
