/// <reference types="vite/client" />

declare module '*.md?raw' {
  const content: string
  export default content
}

declare module '@ai-components/textarea-base' {
  export { Textarea } from '/Volumes/work/web/ai-components/packages/textarea/src/textarea'
}
