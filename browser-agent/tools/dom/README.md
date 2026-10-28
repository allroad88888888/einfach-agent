# Browser DOM tools

`@einfach-agent/tools-browser-dom` is an embeddable, browser-only DOM toolkit. It observes the document supplied by the host and exposes six registry tools without Chrome, React, or site-specific adapters.

Use `read_dom` first and retain its exact `PageRef` and opaque refs. A typical custom-select flow is: read the visible control, click its ref, wait for the body-mounted candidate popup, read the desired candidate, click its exact ref, then read the original control again. A dispatched action is only an event result; the final read is the business-result check. Displayed text is never treated as an undisclosed business value.

The package operates on the supplied top document (or a same-origin iframe document explicitly supplied by a host). Cross-origin frames and closed shadow roots are outside its scope. Events are synthetic (`isTrusted === false`), so sites requiring trusted keyboard defaults or privileged gestures may reject them. Reads and scans are bounded, values and attributes are restricted, and password/hidden inputs are not exposed.
