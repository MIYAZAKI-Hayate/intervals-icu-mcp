import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient } from "../src/intervals.js";

test("uses Intervals.icu Basic auth without exposing the key in the URL", async () => {
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    return new Response(JSON.stringify([{ id: "1" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = new IntervalsClient("secret-key", "https://intervals.example/api/v1", 1000, fakeFetch);
  const result = await client.activities("2026-07-01", "2026-07-07");

  assert.equal(result[0]?.id, "1");
  assert.doesNotMatch(requestedUrl, /secret-key/);
  assert.equal(
    Buffer.from(authorization.replace("Basic ", ""), "base64").toString("utf8"),
    "API_KEY:secret-key"
  );
});
