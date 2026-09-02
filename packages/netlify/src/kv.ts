import type {
  KvKey,
  KvStore,
  KvStoreListEntry,
  KvStoreSetOptions,
} from "@fedify/fedify/federation";
import type { Store } from "@netlify/blobs";
import { isEqual } from "es-toolkit";

/**
 * A key-value store that uses Netlify Blobs.
 *
 * @since 2.4.0
 */
export class NetlifyBlobsKvStore implements KvStore {
  readonly #store: Store;

  /**
   * Creates a new Netlify Blobs-backed key-value store.
   * @param store The Netlify Blobs store to use.
   */
  constructor(store: Store) {
    this.#store = store;
  }

  private serializeKey(key: KvKey): string {
    return JSON.stringify(key);
  }

  private deserializeKey(key: string): KvKey {
    return JSON.parse(key) as KvKey;
  }

  /**
   * {@inheritDoc KvStore.get}
   */
  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const result = await this.#store.getWithMetadata(this.serializeKey(key), {
      type: "json",
    });

    if (result === null) return undefined;

    const expireIn = result.metadata.expireIn;

    if (
      typeof expireIn === "number" &&
      expireIn <= Temporal.Now.instant().epochMilliseconds
    ) {
      return undefined;
    }
    return result.data as T;
  }

  /**
   * {@inheritDoc KvStore.set}
   */
  async set(
    key: KvKey,
    value: unknown,
    options?: KvStoreSetOptions | undefined,
  ): Promise<void> {
    const expireIn = options?.ttl == null
      ? null
      : Temporal.Now.instant().epochMilliseconds +
        options.ttl.total("millisecond");

    await this.#store.setJSON(this.serializeKey(key), value, {
      metadata: { "expireIn": expireIn },
    });
  }

  /**
   * {@inheritDoc KvStore.delete}
   */
  delete(key: KvKey): Promise<void> {
    return this.#store.delete(this.serializeKey(key));
  }

  /**
   * {@inheritDoc KvStore.list}
   */
  async *list(prefix?: KvKey): AsyncIterable<KvStoreListEntry> {
    const serializedPrefix = prefix ? `${this.serializeKey(prefix)}` : "";

    const pages = this.#store.list({
      paginate: true,
      prefix: serializedPrefix,
    });
    for await (const page of pages) {
      for (const blob of page.blobs) {
        const key = this.deserializeKey(blob.key);
        const value = await this.get(key);

        if (value === undefined) continue;

        yield {
          key: key,
          value: value,
        };
      }
    }
  }

  /**
   * {@inheritDoc KvStore.cas}
   */
  async cas(
    key: KvKey,
    expectedValue: unknown,
    newValue: unknown,
    options?: KvStoreSetOptions,
  ): Promise<boolean> {
    while (true) {
      const entry = await this.#store.getWithMetadata(this.serializeKey(key), {
        consistency: "strong",
        type: "json",
      });

      let currentValue;
      // Get only valid data from the fetched entry
      if (entry === null) {
        currentValue = undefined;
      } else {
        const expireIn = entry.metadata.expireIn;

        if (
          typeof expireIn === "number" &&
          expireIn <= Temporal.Now.instant().epochMilliseconds
        ) {
          currentValue = undefined;
        } else {
          currentValue = entry.data;
        }
      }

      if (!isEqual(currentValue ?? undefined, expectedValue)) return false;

      if (entry === null && newValue === undefined) {
        return true;
      }

      const storedValue = newValue === undefined ? null : newValue;
      const serializedKey = this.serializeKey(key);
      const metadata = {
        "expireIn": options?.ttl == null
          ? null
          : Temporal.Now.instant().epochMilliseconds +
            options.ttl.total("millisecond"),
      };

      const result = entry === null
        ? await this.#store.setJSON(serializedKey, storedValue, {
          onlyIfNew: true,
          metadata: metadata,
        })
        : await this.#store.setJSON(serializedKey, storedValue, {
          onlyIfMatch: entry.etag,
          metadata: metadata,
        });

      if (result.modified) return true;
    }
  }
}
