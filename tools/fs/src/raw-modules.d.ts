/** Vite raw 查询导入的文本模块声明。 */
declare module '*.md?raw' {
  const content: string
  export default content
}
