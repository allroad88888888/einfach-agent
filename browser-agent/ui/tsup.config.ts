import { definePackageBuild } from '../../tsup.preset'
export default definePackageBuild({ entry: ['src/index.ts', 'src/styles.css'], external: [] })
