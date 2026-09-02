import { deepStrictEqual, rejects } from "node:assert/strict";
import { describe, it } from "node:test";
import type { KvKey } from "@fedify/fedify/federation";
import type { Store } from "@netlify/blobs";
import { NetlifyBlobsKvStore } from "../src/kv.ts";

interface Entry {
  readonly data: unknown;
  readonly etag: string;
  readonly metadata: Record<string, unknown>;
}

class MockStore {
  readonly entries = new Map<string, Entry>();
  readonly listPrefixes: string[] = [];
  #version = 0;

  getWithMetadata(key: string): Promise<Entry | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  setJSON(
    key: string,
    data: unknown,
    options: { metadata?: Record<string, unknown> } = {},
  ): Promise<{ etag: string; modified: true }> {
    const entry = {
      data,
      etag: `${++this.#version}`,
      metadata: options.metadata ?? {},
    };
    this.entries.set(key, entry);
    return Promise.resolve({ etag: entry.etag, modified: true });
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  async *list(options: { prefix?: string }) {
    const prefix = options.prefix ?? "";
    this.listPrefixes.push(prefix);
    const blobs = [...this.entries]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ key, etag: entry.etag }));
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

  it("rejects encoded keys longer than 600 UTF-8 bytes", async () => {
    const kv = createKv(new MockStore());

    await rejects(
      kv.set(["한".repeat(200)], "too long"),
      new RangeError(
        "The encoded key exceeds Netlify Blobs' 600-byte key limit.",
      ),
    );
  });
});

describe("NetlifyBlobsKvStore.cas()", () => {
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
});
