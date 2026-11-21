---
description: >-
  Reconstruct ActivityPub conversations from FEP-f228 context collections or
  reply relationships using the @fedify/backfill package.
---

Conversation backfill
=====================

*This API is available since Fedify 2.3.0.*

Fedify provides the *@fedify/backfill* package for reconstructing ActivityPub
conversations that may be incomplete on the local server.  It can retrieve
post-like objects from [FEP-f228] context collections and optionally crawl
`inReplyTo` ancestors and `replies` descendants.

[FEP-f228]: https://w3id.org/fep/f228


Installation
------------

::: code-group

~~~~ sh [npm]
npm add @fedify/backfill
~~~~

~~~~ sh [pnpm]
pnpm add @fedify/backfill
~~~~

~~~~ sh [Yarn]
yarn add @fedify/backfill
~~~~

~~~~ sh [Bun]
bun add @fedify/backfill
~~~~

~~~~ sh [Deno]
deno add jsr:@fedify/backfill
~~~~

:::


Backfilling a conversation
--------------------------

The `backfill()` function accepts a backfill context, a seed object, and
traversal options.  The context supplies a `documentLoader` for dereferencing
context and history collections, collection items, reply targets, and replies
collections:

~~~~ typescript twoslash
import { backfill, type BackfillDocumentLoader } from "@fedify/backfill";
import { lookupObject, Note } from "@fedify/vocab";

declare const note: Note;
// ---cut-before---
const documentLoader: BackfillDocumentLoader = (iri, options) =>
  lookupObject(iri, { signal: options?.signal });

for await (
  const item of backfill({ documentLoader }, note, {
    maxItems: 20,
    maxRequests: 50,
  })
) {
  console.log(item.id?.href);
}
~~~~

Custom `BackfillDocumentLoader` implementations are responsible for validating
the objects they return. For origin validation, pass a custom JSON-LD
`DocumentLoader` to `lookupObject()` and have it set `documentUrl` to the
final response URL after redirects. By default, `lookupObject()` checks the
top-level object's declared ID against that origin. Backfill
dereferences cross-origin embedded objects through the vocabulary accessors,
which apply this check only to objects decoded with `fromJsonLd()` or
`lookupObject()`. Objects passed to a constructor are trusted as they are, so a
loader must not build remote data with constructors.

When checking an ordinary HTTP(S) object's origin, backfill compares its ID
with the origin of the final response URL when the loader reports it.  A custom
loader that retains the final URL can call
`options?.reportDocumentUrl?.(finalUrl)` before returning the object.  Report
the actual URL of the response used to parse that object.  When the loader
returns only the object, as `lookupObject()` does, backfill checks its ID
against the requested IRI instead. A reported final URL lets cross-origin
redirects pass the check when the returned ID matches the final response's
origin. Backfill also uses the reported URL to resolve relative links, even
when an ordinary HTTP(S) object has no ID.

Portable `ap:` and `ap+ef61:` identifiers are still compared against the
requested reference by DID, including valid FEP-ef61 compatible gateway
identifiers.  The loader must verify portable proofs before returning these
objects.  Matching origins alone do not authenticate their content.

Set `crossOrigin` on the backfill options to control how traversal handles
cross-origin objects:

 -  `"ignore"` (default) dereferences cross-origin embedded objects by ID
    and skips fetched objects that fail backfill's origin check.
 -  `"throw"` also dereferences embedded objects by ID and raises an error
    when a fetched object fails that check.
 -  `"trust"` allows ordinary HTTP(S) objects regardless of origin, whether
    embedded or fetched. Loader validation and portable identity checks still
    apply. This can expose applications to content spoofing. Only use this
    mode if you validate the returned objects before persisting them.

Backfill's `crossOrigin` controls its own checks. If the loader has already
skipped an object, backfill cannot recover it with `"trust"` or report an
origin mismatch with `"throw"`. For example, `lookupObject()` returns `null`
on an ordinary origin mismatch under its default policy.

::: warning Previously hydrated references
An earlier backfill call or a direct vocabulary accessor call using
`crossOrigin: "trust"` can replace a reference on a shared seed or loader
result with a fetched object. Later `"ignore"` and `"throw"` traversals can
reuse that object without checking its origin again. To apply a stricter
policy, pass a freshly parsed seed and have the loader return freshly parsed
objects from the original documents. Copying an already hydrated object
carries over its cached values.
:::

In `"ignore"` and `"throw"` modes, dereferencing an embedded object may make
an extra `documentLoader` call that counts against `maxRequests`.

Backfilled objects remain unverified remote data.  Applications should
authenticate them before persisting or otherwise trusting them.

The seed object itself is not yielded.  If the same object appears in a
discovered collection, it is skipped by ID.

By default, `backfill()` uses the `"context-auto"` strategy.  It expects the
seed's first `context` ID to dereference to a `Collection`, `OrderedCollection`,
`CollectionPage`, or `OrderedCollectionPage`.  Ordinary post-like items are
yielded directly, while supported `Create` activities are unwrapped and their
objects are yielded.

Without history selection or ancestor discovery, if the seed has no context,
or its context resolves to a non-collection, context strategies yield nothing.

### Selecting conversation history

*This option is available since Fedify 2.5.0.*

Set `contextSource: "history-first"` to read the first `contextHistory`
value on the supplied seed. It can be a reference or an embedded collection.
For example, a seed with history but no `context` can yield posts from supported
`Create` activities:

~~~~ typescript twoslash
import { backfill, type BackfillContext } from "@fedify/backfill";
import { Note } from "@fedify/vocab";

declare const context: BackfillContext;
// ---cut-before---
const seed = new Note({
  contextHistory: new URL("https://example.com/conversations/1/history"),
});
for await (const item of backfill(context, seed, {
  contextSource: "history-first",
})) {
  console.log(item.object);
}
~~~~

Backfill falls back to the seed's first `context` ID if history is absent or
unavailable: the lookup returns `null`, the loader throws an ordinary error, or
the result is not a supported collection. Both embedded and referenced history
support the collection and page types listed above.

Once a history collection is resolved, it remains selected, even if it
is empty, has no supported items, or later item or page loads fail. Backfill
does not try later history values or merge history with `context`. The selected
source is reused across context strategies within the same traversal.

Backfill does not unwrap `Add` activities. Histories containing only
`Add(Create(...))` activities yield nothing and do not trigger `context`
fallback.

An embedded history accepted without dereferencing needs no request;
referenced items and pages still count. A failed history lookup consumes
request budget, and context fallback uses the remaining budget and the same
document cache. If no source can be resolved on the seed, context strategies
yield nothing unless
[ancestor discovery](#discovering-collections-through-ancestors) is enabled.

Referenced history is resolved through the configured `documentLoader`,
including portable `ap://`, `ap+ef61://`, and FEP-ef61-compatible HTTPS
references. The loader is responsible for resolving and verifying portable
objects, as with other objects it returns.

This option chooses the source for the existing context strategies. Later
explicitly configured strategies, including `"reply-tree"`, can still run.
By itself, it does not discover history on ancestors. It does not unwrap `Add`
activities or replay updates and deletions. Omitting the option preserves
existing source selection.

### Discovering collections through ancestors

*This option is available since Fedify 2.5.0.*

Set `contextDiscovery: "ancestors"` when starting from a reply whose own
collection may be absent or unavailable:

~~~~ typescript twoslash
import { backfill, type BackfillContext } from "@fedify/backfill";
import { Note } from "@fedify/vocab";

declare const context: BackfillContext;
declare const reply: Note;
// ---cut-before---
for await (const item of backfill(context, reply, {
  contextDiscovery: "ancestors",
  maxDepth: 5,
})) {
  console.log(item.object);
}
~~~~

Context strategies first try the seed, then follow `inReplyTo` ancestors up to
`maxDepth` (10 by default). The nearest ancestor with a usable collection wins;
reply-target property order breaks ties at the same depth. The selected
collection stays fixed across context strategies, even if empty or containing
no supported items. Ancestor collections are not merged. Failed ancestor
lookups leave other reply targets available for discovery.

Enabling ancestor discovery can produce vocabulary warnings such as
`Failed to fetch …` for missing reply targets, already visited references, or
lookups blocked by the remaining request budget. These warnings can describe
expected skips during traversal and do not by themselves mean discovery has
stopped.

Combine this option with `contextSource: "history-first"` to apply history-first
selection to the seed and each ancestor. Otherwise, discovery uses their first
`context` IDs. Omitting `contextDiscovery` makes no ancestor requests from
context strategies.

Collection items have `origin: "collection"` and `depth: 0`. To also yield
ancestors and crawl `replies`, configure the `"reply-tree"` strategy. Later
strategies run in their configured order. Discovery shares the traversal
controls, caching, and ID deduplication described below.

Per-object loader and portable-object verifier defaults remain effective
regardless of strategy order. Discovery does not hydrate the seed or loaded
ancestor objects.

Ancestor discovery deep-clones the seed and loaded ancestors, including their
embedded object graphs. Large embedded collections can therefore increase
memory use and copying time independently of `maxDepth`. Objects yielded by
`reply-tree` may be copies rather than the caller's original instances.


Strategies
----------

Strategies run in the configured order.  They share request and item budgets,
abort state, document caching, and object ID deduplication.  If multiple
strategies discover the same object, the first one keeps its `BackfillItem`
metadata.

`"context-auto"`
:   Handles both direct post-like objects and supported `Create` activities
    from a context collection.  This is the default strategy.

`"context-objects"`
:   Accepts only post-like objects contained directly in a context collection:

    ~~~~ typescript twoslash
    import { backfill, type BackfillContext } from "@fedify/backfill";
    import { Note } from "@fedify/vocab";

    declare const context: BackfillContext;
    declare const note: Note;
    // ---cut-before---
    for await (
      const item of backfill(context, note, {
        strategies: ["context-objects"],
      })
    ) {
      console.log(item.object);
    }
    ~~~~

`"context-activities"`
:   Accepts supported activities from a context collection.  It currently
    supports `Create` and yields the activity's object rather than the activity
    itself:

    ~~~~ typescript twoslash
    import { backfill, type BackfillContext } from "@fedify/backfill";
    import { Note } from "@fedify/vocab";

    declare const context: BackfillContext;
    declare const note: Note;
    // ---cut-before---
    for await (
      const item of backfill(context, note, {
        strategies: ["context-activities"],
      })
    ) {
      console.log(item.object);
    }
    ~~~~

`"reply-tree"`
:   Walks `inReplyTo` ancestors and `replies` descendants.  It yields
    post-like objects only and does not unwrap Activity objects.  This strategy
    is opt-in because it can require substantially more network requests than
    a context collection.

For hybrid coverage, run the FEP-f228 path first and use reply-tree traversal
after it:

~~~~ typescript twoslash
import { backfill, type BackfillContext } from "@fedify/backfill";
import { Note } from "@fedify/vocab";

declare const context: BackfillContext;
declare const note: Note;
// ---cut-before---
for await (
  const item of backfill(context, note, {
    strategies: ["context-auto", "reply-tree"],
    maxDepth: 4,
  })
) {
  console.log(item.origin, item.depth, item.object);
}
~~~~


Traversal controls
------------------

`maxItems`
:   Limits the number of yielded objects.  Skipped duplicates do not count.

`maxRequests`
:   Limits calls to `documentLoader`. Embedded objects and collections accepted
    without fetching do not count as requests.

`maxDepth`
:   Limits reply-tree traversal and ancestor collection discovery, and defaults
    to 10. Immediate parents and direct replies have depth 1; their next-level
    parents or replies have depth 2, and so on. Context collection items have
    depth 0 and are not limited by this option.

`interval`
:   Adds a delay between `documentLoader` requests.  A callback receives the
    zero-based request index.  String durations require the global `Temporal`
    API or a polyfill; `Temporal.DurationLike` objects work without the global
    API.

`signal`
:   Cancels traversal before requests and yields.  The signal is also passed to
    `documentLoader`.


Caching and failures
--------------------

Dereferenced documents are cached in memory for one `backfill()` traversal.
Applications that need persistent or shared caching can implement it in the
provided `documentLoader`.

Ordinary dereference failures are skipped so other conversation items can
still be discovered. Thrown loader errors are not retained in the traversal
cache, allowing the same IRI to be retried if another traversal path reaches
it. A returned `null` is cached for the rest of the traversal.

An origin mismatch raised in `"throw"` mode stops traversal. Cancellation,
errors cloning embedded history, and interval configuration errors also stop
traversal. These cases do not trigger source fallback or allow later
strategies to continue.
