---
links:
  '#1427': https://github.com/fedify-dev/fedify/issues/1427
---
 -  Added `BackfillOptions.crossOrigin` to control origin checks for embedded
    and fetched objects. The default `"ignore"` dereferences cross-origin
    embedded objects by ID and skips fetched origin mismatches. `"throw"`
    reports a mismatch as an error. Any resulting loader calls count against
    `maxRequests`. `"trust"` uses the vocabulary's trust policy for embedded
    objects and bypasses backfill's origin check for ordinary HTTP(S) fetches.
    This can expose applications to content spoofing. Validate results
    before persisting them. Fetched portable IDs still use the requested DID.
    [[#1427] by Jiwon Kwon]

    Loaders can report the final response URL with `reportDocumentUrl()` so
    backfill can validate legitimate redirects and preserve the response URL
    as the base when a vocabulary accessor reparses the object.
