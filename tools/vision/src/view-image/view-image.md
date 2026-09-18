# view_image

Read one JPEG, PNG, or WebP image at an explicit path and return it to the
current multimodal model as image tool content.

## Parameters

- `path` (required): a non-empty image path.
- `detail` (optional): use `low` for ordinary images. Use `high` for OCR,
  small text in screenshots, dense charts or diagrams, and fine visual
  comparisons.

`low` is the default. Choose `high` only when those details matter.
