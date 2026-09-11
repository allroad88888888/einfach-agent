/** Browser-local image bytes after Composer validation and before transport encoding. */
export interface LocalImageInput {
  data: Blob
  name: string
  mimeType: string
  width?: number
  height?: number
}
