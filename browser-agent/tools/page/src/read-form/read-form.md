# read_form

Read safe field metadata from the page already bound by the host. This tool accepts no tab, target, selector, or script. Password and hidden inputs are omitted. Keep the returned `page` and opaque field IDs unchanged for later fill or validation calls. Read again after navigation or replacement of a control.

Each field label prefers explicit ARIA/native label relationships and the control title. For component-library markup, a single visible title from the nearest one-control form item may be used. Names and placeholders are only fallbacks; nearby descriptions, errors, option text, multi-control rows, and nested forms are not treated as field titles.

Discovery proceeds from native HTML controls to explicit ARIA/contenteditable semantics, then to a constrained DOM fallback for one labelled, focusable control root. Site-specific controls belong in `controlledAdapters`. A field can be editable in the page while `supported:false`: `readOnly` reports the page state, while `supported` reports whether this host has a safe write adapter.

`optionsStatus:"exposed"` means the currently rendered DOM exposed the complete set reported in this snapshot; it does not promise remote or unopened choices. `optionsStatus:"not-exposed"` means no linked listbox/tree is currently present. Stable native or DOM values appear in `options`; visible choices without a stable value appear only in `optionLabels`. Reading never opens a popup or dispatches events.

When a visible custom control is `supported:false`, switch to the generic DOM flow: `read_dom` → `click_dom` → `wait_for_dom`/`read_dom` → click the exact observed candidate → read the original field or DOM control again. Treat the final business-facing read as verification; displayed text does not prove an undisclosed underlying value.
