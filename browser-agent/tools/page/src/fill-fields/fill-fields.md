# fill_fields

Fill fields using the exact `page` and opaque IDs returned by `read_form`. Strings apply to text, textarea, and single select; booleans to checkbox and radio; string arrays to multiple select. The host dispatches `input` and `change`, reads the actual result back, and returns one outcome per requested field. A normalized or rejected value is `ok:false` with the actual value; multi-select order is ignored. Writes to one document run in call order. Partial success is possible. Do not automatically retry an unknown write. Conversation undo cannot reverse page changes.
