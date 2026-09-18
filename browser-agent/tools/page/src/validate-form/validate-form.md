# validate_form

Check current constraints for all fields or the requested opaque field IDs. Use the exact `page` returned by `read_form`. Validation only reads current state: it does not submit the form or change values. Controlled component adapters may provide their own validation rule.
