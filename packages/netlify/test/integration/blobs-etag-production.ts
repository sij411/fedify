import { ok } from "node:assert/strict";
import { getStore } from "@netlify/blobs";

const siteID = process.env.NETLIFY_SITE_ID;
const token = process.env.NETLIFY_AUTH_TOKEN;
if (siteID == null || token == null) {
  throw new Error("Missing NETLIFY_SITE_ID or NETLIFY_AUTH_TOKEN.");
}

const loggingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const method = init?.method ??
    (input instanceof Request ? input.method : "GET");
  const requestUrl = new URL(
    input instanceof Request ? input.url : input.toString(),
  );
  console.log({
    method,
    target: requestUrl.hostname === "api.netlify.com"
      ? "Netlify API"
      : "blob storage",
    status: response.status,
    etag: response.headers.get("etag"),
  });
  return response;
};

const store = getStore({
  consistency: "strong",
  fetch: loggingFetch,
  name: "etag-production-reproduction",
  siteID,
  token,
});
const key = `etag-test-${crypto.randomUUID()}`;

let etags: {
  readonly getMetadata: string | null;
  readonly getWithMetadata: string | null;
  readonly list: string | null;
  readonly setJSON: string | null;
};

try {
  const write = await store.setJSON(key, { value: 1 });
  const read = await store.getWithMetadata(key, {
    consistency: "strong",
    type: "json",
  });
  const metadata = await store.getMetadata(key, {
    consistency: "strong",
  });
  const list = await store.list({ prefix: key });

  etags = {
    setJSON: write.etag ?? null,
    getWithMetadata: read?.etag ?? null,
    getMetadata: metadata?.etag ?? null,
    list: list.blobs.find((blob) => blob.key === key)?.etag ?? null,
  };
} finally {
  await store.delete(key);
}

console.log(JSON.stringify(etags, null, 2));
ok(etags.getWithMetadata, "getWithMetadata() did not return an ETag");
ok(etags.getMetadata, "getMetadata() did not return an ETag");
