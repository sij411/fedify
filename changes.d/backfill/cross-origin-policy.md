---
links:
  '#1427': https://github.com/fedify-dev/fedify/issues/1427
---
 -  Added `BackfillOptions.crossOrigin` to control origin checks for embedded
    and fetched objects. The default `"ignore"` dereferences cross-origin
    embedded objects by ID and skips fetched origin mismatches. `"throw"`
    reports a mismatch as an error. Any resulting loader calls count against
    `maxRequests`. `"trust"` relaxes origin checks for ordinary HTTP(S)
    objects and can expose applications to content spoofing. Validate results
    before persisting them. Portable identity checks still apply.
    [[#1427] by Jiwon Kwon]

    Loaders can report the final response URL with `reportDocumentUrl()` so
    backfill can validate legitimate redirects and resolve relative links
    against the URL that served the object.
