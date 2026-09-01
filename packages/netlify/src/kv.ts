import type {
    KvKey,
    KvStore,
    KvStoreListEntry,
    KvStoreSetOptions,
} from "@fedify/fedify/federation";
import type { Store } from "@netlify/blobs";

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

  async get<T = unknown>(key: KvKey): Promise<T | undefined> {
    const result = await this.#store.getWithMetadata(this.serializeKey(key), {
      type: "json",
    });

    if (result === null) return undefined;

    const expiresIn = result.metadata.expiresIn;

    if (
      typeof expiresIn === "number" &&
      expiresIn <= Temporal.Now.instant().epochMilliseconds
    ) {
      return undefined;
    }
    return result.data as T;
  }

  async set(
    key: KvKey,
    value: unknown,
    options?: KvStoreSetOptions | undefined,
  ): Promise<void> {
    const expiresIn = options?.ttl == null
      ? null
      : Temporal.Now.instant().epochMilliseconds +
        options.ttl.total("millisecond");

    await this.#store.setJSON(this.serializeKey(key), value, {
      metadata: { "expiresIn": expiresIn },
    });
  }

  delete(key: KvKey): Promise<void> {
    return this.#store.delete(this.serializeKey(key));
  }

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
}
