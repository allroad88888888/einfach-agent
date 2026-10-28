# press_dom_key

Dispatch untrusted bubbling `keydown` and `keyup` events to an observed node. This can invoke page handlers, but synthetic keys do not provide trusted browser default behavior such as native typing or privileged shortcuts. Re-read the DOM to confirm any application result.
