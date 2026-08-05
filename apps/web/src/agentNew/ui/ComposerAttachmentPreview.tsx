import { useEffect, useRef } from 'react'

/** A DOM-only object URL owner. URLs never enter Composer's atom state. */
export function ComposerAttachmentPreview({ file, alt }: { readonly file: File; readonly alt: string }) {
  const imageRef = useRef<HTMLImageElement>(null)
  useEffect(() => {
    const url = URL.createObjectURL(file)
    const image = imageRef.current
    if (image) image.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])
  return <img ref={imageRef} className="agentnew-composer-image-preview" alt={alt} />
}
