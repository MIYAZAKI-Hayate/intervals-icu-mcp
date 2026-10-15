import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient, sanitizeActivityDetail } from "../src/intervals.js";

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

test("retrieves activity intervals and excludes location and raw streams", async () => {
  let requestedUrl = "";
  const fakeFetch: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      id: "i123",
      type: "Ride",
      latitude: 35.0,
      longitude: 139.0,
      streams: [{ type: "latlng", data: [[35.0, 139.0]] }],
      icu_intervals: [{
        type: "WORK", start_time: 60, end_time: 360, moving_time: 300,
        distance: 2500, average_speed: 8.33, average_heartrate: 150, average_watts: 220
      }]
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new IntervalsClient("test-key", "https://intervals.example/api/v1", 1000, fakeFetch);
  const detail = sanitizeActivityDetail(await client.activity("i123"));
  assert.equal(requestedUrl, "https://intervals.example/api/v1/activity/i123?intervals=true");
  assert.equal(detail.intervalCount, 1);
  assert.equal(detail.intervals[0]?.averageWatts, 220);
  assert.equal(detail.intervals[0]?.averageHeartRate, 150);
  assert.doesNotMatch(JSON.stringify(detail), /latitude|longitude|latlng|streams/);
});

test("limits returned intervals to 200", () => {
  const detail = sanitizeActivityDetail({
    id: "i123",
    icu_intervals: Array.from({ length: 201 }, () => ({ type: "WORK" }))
  });
  assert.equal(detail.intervalCount, 201);
  assert.equal(detail.intervals.length, 200);
  assert.equal(detail.intervalsTruncated, true);
});
