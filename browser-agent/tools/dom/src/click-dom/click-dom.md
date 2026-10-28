# click_dom

Click an exact ref previously returned by `read_dom`. The host uses the page's ordinary event path, so a plain `div` or `span` can trigger delegated handlers and body-mounted popups. A dispatched result only confirms event dispatch; read or wait for the resulting DOM and verify the business-facing value. Re-read after replacement or navigation. Disabled, hidden, stale, unknown, and removed nodes are rejected.
