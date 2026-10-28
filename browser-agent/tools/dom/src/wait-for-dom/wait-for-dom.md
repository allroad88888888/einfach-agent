# wait_for_dom

Wait until a filtered DOM read is present or absent. Supply the current `PageRef`; use `text`, `selector`, or an observed `scopeRef` to identify the result. Waiting is bounded, cancellable, and passive. After an asynchronous popup appears, read its exact candidate ref, click it, then read the target control again. Visible labels are not assumed to equal hidden business values.
