import "temporal-polyfill/global";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { KvKey } from "@fedify/fedify/federation";
import type { SetOptions, Store } from "@netlify/blobs";
import { NetlifyBlobsKvStore } from "../src/kv.ts";

interface Entry {
  readonly data: unknown;
  readonly etag?: string;
  readonly metadata: Record<string, unknown>;
}

class MockStore {
  readonly entries = new Map<string, Entry>();
  readonly getCalls: {
    readonly key: string;
    readonly consistency?: "eventual" | "strong";
    readonly type?: string;
  }[] = [];
  readonly setCalls: {
    readonly key: string;
    readonly data: unknown;
    readonly options: SetOptions;
  }[] = [];
  readonly deleteCalls: string[] = [];
  readonly listPrefixes: string[] = [];
  beforeNextSet?: () => void;
  #version = 0;

  getWithMetadata(
    key: string,
    options: {
      consistency?: "eventual" | "strong";
      type?: string;
    } = {},
  ): Promise<Entry | null> {
    this.getCalls.push({
      key,
      consistency: options.consistency,
      type: options.type,
    });
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  setJSON(
    key: string,
    data: unknown,
    options: SetOptions = {},
  ): Promise<{ etag?: string; modified: boolean }> {
    this.setCalls.push({ key, data, options });
    const beforeSet = this.beforeNextSet;
    this.beforeNextSet = undefined;
    beforeSet?.();

    const current = this.entries.get(key);
    if (
      (options.onlyIfNew === true && current != null) ||
      (options.onlyIfMatch != null && current?.etag !== options.onlyIfMatch)
    ) {
      return Promise.resolve({ modified: false });
    }

    const entry = {
      data,
      etag: `${++this.#version}`,
      metadata: options.metadata ?? {},
    };
    this.entries.set(key, entry);
    return Promise.resolve({ etag: entry.etag, modified: true });
  }

  delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.entries.delete(key);
    return Promise.resolve();
  }

  async *list(options: { prefix?: string }) {
    const prefix = options.prefix ?? "";
    this.listPrefixes.push(prefix);
    const blobs = [...this.entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, etag: entry.etag ?? "" }));
    for (const blob of blobs) {
      yield { blobs: [blob], directories: [] };
    }
  }
}

function createKv(store: MockStore): NetlifyBlobsKvStore {
  return new NetlifyBlobsKvStore(store as unknown as Store);
}

async function collect(
  entries: AsyncIterable<{ key: KvKey; value: unknown }>,
) {
  return await Array.fromAsync(entries);
}

describe("NetlifyBlobsKvStore", () => {
  it("gets, sets, and overwrites JSON values", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    deepStrictEqual(await kv.get(["missing"]), undefined);
    equal(store.getCalls[0].type, "json");

    const values = [null, false, 0, "", [1, 2], { nested: true }];
    for (const [index, value] of values.entries()) {
      const key: KvKey = ["value", `${index}`];
      await kv.set(key, value);
      deepStrictEqual(await kv.get(key), value);
    }

    await kv.set(["overwrite"], "first");
    await kv.set(["overwrite"], "second");
    deepStrictEqual(await kv.get(["overwrite"]), "second");
  });

  it("deletes existing and missing keys", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["delete"], "value");

    await kv.delete(["delete"]);
    await kv.delete(["missing"]);

    deepStrictEqual(await kv.get(["delete"]), undefined);
    deepStrictEqual(store.deleteCalls, ['["delete"]', '["missing"]']);
  });

  it("stores TTL metadata and hides expired values", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    const before = Date.now();
    await kv.set(["future"], "visible", {
      ttl: Temporal.Duration.from({ seconds: 1 }),
    });
    const expires = store.entries.get('["future"]')?.metadata.expireIn;
    ok(typeof expires === "number");
    ok(expires >= before + 1_000);

    store.entries.set('["expired"]', {
      data: "hidden",
      etag: "expired",
      metadata: { expireIn: Date.now() - 1 },
    });
    deepStrictEqual(await kv.get(["future"]), "visible");
    deepStrictEqual(await kv.get(["expired"]), undefined);
    deepStrictEqual(await collect(kv.list()), [
      { key: ["future"], value: "visible" },
    ]);
  });

  it("clears TTL metadata when overwriting without a TTL", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["ttl-overwrite"], "expiring", {
      ttl: Temporal.Duration.from({ seconds: 1 }),
    });

    await kv.set(["ttl-overwrite"], "persistent");

    deepStrictEqual(store.entries.get('["ttl-overwrite"]')?.metadata, {
      expireIn: null,
    });
    deepStrictEqual(await kv.get(["ttl-overwrite"]), "persistent");
  });
});

describe("NetlifyBlobsKvStore key encoding", () => {
  it("round-trips structured keys across paginated listings", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    const entries = [
      { key: ["actor"] as KvKey, value: 1 },
      { key: ["actor", "alice"] as KvKey, value: 2 },
      { key: ["actor", 'quoted"],comma'] as KvKey, value: 3 },
      { key: ["", "雪"] as KvKey, value: 4 },
    ];
    for (const { key, value } of entries) await kv.set(key, value);
    store.entries.set("unrelated-blob", {
      data: "ignored",
      etag: "unrelated",
      metadata: {},
    });

    deepStrictEqual(await collect(kv.list()), entries);
    deepStrictEqual(store.listPrefixes, ["["]);
  });

  it("preserves tuple prefixes without matching partial components", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["actor"], "exact");
    await kv.set(["actor", "alice"], "child");
    await kv.set(["actor", "alice", "inbox"], "descendant");
    await kv.set(["actors"], "different");

    deepStrictEqual(await collect(kv.list(["actor"])), [
      { key: ["actor"], value: "exact" },
      { key: ["actor", "alice"], value: "child" },
      { key: ["actor", "alice", "inbox"], value: "descendant" },
    ]);
    deepStrictEqual(await collect(kv.list(["actor", "alice"])), [
      { key: ["actor", "alice"], value: "child" },
      { key: ["actor", "alice", "inbox"], value: "descendant" },
    ]);
    deepStrictEqual(store.listPrefixes, [
      '["actor"',
      '["actor","alice"',
    ]);
  });

  it("enforces the 600-byte UTF-8 key limit", async () => {
    const kv = createKv(new MockStore());

    await kv.set(["a".repeat(596)], "exactly 600 bytes");
    deepStrictEqual(
      await kv.get(["a".repeat(596)]),
      "exactly 600 bytes",
    );

    await rejects(
      kv.set(["a".repeat(597)], "too long"),
      new RangeError(
        "The encoded key exceeds Netlify Blobs' 600-byte key limit.",
      ),
    );
    await rejects(
      kv.set(["한".repeat(200)], "too long in UTF-8"),
      new RangeError(
        "The encoded key exceeds Netlify Blobs' 600-byte key limit.",
      ),
    );
  });

  it("filters expired values and tombstones across pages", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["listed", "visible"], "value");
    store.entries.set('["listed","expired"]', {
      data: "expired",
      etag: "expired",
      metadata: { expireIn: Date.now() - 1 },
    });
    store.entries.set('["listed","deleted"]', {
      data: null,
      etag: "deleted",
      metadata: { tombstone: true },
    });

    deepStrictEqual(await collect(kv.list(["listed"])), [
      { key: ["listed", "visible"], value: "value" },
    ]);
  });
});

describe("NetlifyBlobsKvStore.cas()", () => {
  it("creates a missing key only when undefined is expected", async () => {
    const store = new MockStore();
    const kv = createKv(store);

    equal(await kv.cas(["create"], "wrong", "value"), false);
    equal(await kv.cas(["create"], undefined, "value"), true);
    deepStrictEqual(await kv.get(["create"]), "value");
    equal(store.setCalls.length, 1);
    equal(store.setCalls[0].options.onlyIfNew, true);
    equal(store.getCalls[0].consistency, "strong");
    equal(store.getCalls[0].type, "json");
  });

  it("updates a matching value with its ETag", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["update"], { count: 1 });
    const etag = store.entries.get('["update"]')?.etag;
    store.setCalls.length = 0;

    equal(await kv.cas(["update"], { count: 0 }, { count: 2 }), false);
    equal(await kv.cas(["update"], { count: 1 }, { count: 2 }), true);
    deepStrictEqual(await kv.get(["update"]), { count: 2 });
    equal(store.setCalls.length, 1);
    equal(store.setCalls[0].options.onlyIfMatch, etag);
  });

  it("distinguishes null from an absent key", async () => {
    const kv = createKv(new MockStore());
    await kv.set(["null"], null);

    equal(await kv.cas(["null"], undefined, "wrong"), false);
    equal(await kv.cas(["null"], null, "updated"), true);
    deepStrictEqual(await kv.get(["null"]), "updated");
  });

  it("conditionally replaces a value with a tombstone", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["deleted"], "value");

    deepStrictEqual(await kv.cas(["deleted"], "wrong", undefined), false);
    deepStrictEqual(await kv.cas(["deleted"], "value", undefined), true);
    deepStrictEqual(await kv.get(["deleted"]), undefined);
    deepStrictEqual(await collect(kv.list(["deleted"])), []);
    deepStrictEqual(store.entries.get('["deleted"]')?.data, null);
    deepStrictEqual(
      store.entries.get('["deleted"]')?.metadata,
      { tombstone: true },
    );
  });

  it("recreates a tombstoned key with its ETag", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["recreate"], "old");
    await kv.cas(["recreate"], "old", undefined);
    const tombstoneEtag = store.entries.get('["recreate"]')?.etag;
    store.setCalls.length = 0;

    equal(await kv.cas(["recreate"], undefined, "new"), true);
    deepStrictEqual(await kv.get(["recreate"]), "new");
    equal(store.setCalls[0].options.onlyIfMatch, tombstoneEtag);
    deepStrictEqual(store.setCalls[0].options.metadata, { expireIn: null });
  });

  it("replaces an expired blob with its ETag", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    store.entries.set('["expired-cas"]', {
      data: "old",
      etag: "expired-etag",
      metadata: { expireIn: Date.now() - 1 },
    });

    equal(await kv.cas(["expired-cas"], undefined, "new"), true);
    deepStrictEqual(await kv.get(["expired-cas"]), "new");
    equal(store.setCalls[0].options.onlyIfMatch, "expired-etag");
    equal(store.setCalls[0].options.onlyIfNew, undefined);
  });

  it("applies TTL metadata to a successful write", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    const before = Date.now();

    equal(
      await kv.cas(["ttl-cas"], undefined, "value", {
        ttl: Temporal.Duration.from({ seconds: 1 }),
      }),
      true,
    );
    const expires = store.setCalls[0].options.metadata?.expireIn;
    ok(typeof expires === "number");
    ok(expires >= before + 1_000);
  });

  it("allows only one concurrent create", async () => {
    const kv = createKv(new MockStore());
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        (_, index) => kv.cas(["create-race"], undefined, index),
      ),
    );

    equal(results.filter(Boolean).length, 1);
  });

  it("allows only one concurrent update from the same value", async () => {
    const kv = createKv(new MockStore());
    await kv.set(["update-race"], "old");
    const results = await Promise.all(
      Array.from(
        { length: 10 },
        (_, index) => kv.cas(["update-race"], "old", index),
      ),
    );

    equal(results.filter(Boolean).length, 1);
  });

  it("retries when the ETag changes but the value does not", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["retry"], "old");
    store.setCalls.length = 0;
    store.beforeNextSet = () => {
      store.entries.set('["retry"]', {
        data: "old",
        etag: "competing-etag",
        metadata: { expireIn: null },
      });
    };

    equal(await kv.cas(["retry"], "old", "new"), true);
    equal(store.setCalls.length, 2);
    equal(store.setCalls[1].options.onlyIfMatch, "competing-etag");
  });

  it("does not delete a value changed by a concurrent writer", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    await kv.set(["delete-conflict"], "old");
    store.setCalls.length = 0;
    store.beforeNextSet = () => {
      store.entries.set('["delete-conflict"]', {
        data: "new",
        etag: "competing-etag",
        metadata: { expireIn: null },
      });
    };

    equal(await kv.cas(["delete-conflict"], "old", undefined), false);
    deepStrictEqual(await kv.get(["delete-conflict"]), "new");
    equal(store.setCalls.length, 1);
    deepStrictEqual(store.setCalls[0].options.metadata, { tombstone: true });
  });

  it("does not write when deleting a missing key", async () => {
    const store = new MockStore();
    const kv = createKv(store);

    equal(await kv.cas(["missing-delete"], undefined, undefined), true);
    equal(store.setCalls.length, 0);
  });

  it("rejects conditional writes when the ETag is missing", async () => {
    const store = new MockStore();
    const kv = createKv(store);
    store.entries.set('["missing-etag"]', {
      data: "old",
      metadata: {},
    });

    await rejects(
      kv.cas(["missing-etag"], "old", "new"),
      new Error("Netlify Blobs did not return an ETag."),
    );
  });
});
