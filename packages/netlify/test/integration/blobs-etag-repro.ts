import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { BlobsServer } from "@netlify/blobs/server";

const directory = await mkdtemp(join(tmpdir(), "netlify-blobs-etag-"));
const token = "test-token";
const server = new BlobsServer({ directory, token });
const loggingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const method = init?.method ??
    (input instanceof Request ? input.method : "GET");
  const url = input instanceof Request ? input.url : input.toString();
  console.log(method, url, response.status, {
    headers: Object.fromEntries(response.headers),
  });
  return response;
};

let etags: {
  readonly getMetadata: string | null;
  readonly getWithMetadata: string | null;
  readonly list: string | null;
  readonly setJSON: string | null;
};

try {
  const { address } = await server.start();
  const store = getStore({
    apiURL: address,
    consistency: "strong",
    fetch: loggingFetch,
    name: "etag-reproduction",
    siteID: "test-site",
    token,
  });
  const write = await store.setJSON("key", { value: 1 });
  const read = await store.getWithMetadata("key", {
    consistency: "strong",
    type: "json",
  });
  const metadata = await store.getMetadata("key", {
    consistency: "strong",
  });
  const list = await store.list({ prefix: "key" });
  const unchanged = await store.getWithMetadata("key", {
    consistency: "strong",
    etag: write.etag,
    type: "json",
  });

  etags = {
    setJSON: write.etag ?? null,
    getWithMetadata: read?.etag ?? null,
    getMetadata: metadata?.etag ?? null,
    list: list.blobs.find((blob) => blob.key === "key")?.etag ?? null,
  };

  console.log(JSON.stringify(etags, null, 2));
  ok(etags.getWithMetadata, "getWithMetadata() did not return an ETag");
  ok(etags.getMetadata, "getMetadata() did not return an ETag");
  equal(unchanged?.data, null);
  equal(unchanged?.etag, write.etag);
  deepStrictEqual(read?.data, { value: 1 });

  console.log();
} finally {
  await server.stop();
  await rm(directory, { recursive: true, force: true });
}
