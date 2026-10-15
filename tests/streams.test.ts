import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient, type JsonObject } from "../src/intervals.js";
import { summarizeStreams } from "../src/streams.js";

function stream(type: string, data: unknown[]): JsonObject { return { type, data }; }

test("stream requests use a numeric-metric allowlist and never request GPS defaults", async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, "/api/v1/activity/i123/streams.json");
    assert.deepEqual(url.searchParams.get("types")?.split(","), ["time", "heartrate", "watts", "cadence", "velocity_smooth", "distance", "altitude", "moving"]);
    assert.equal(url.searchParams.get("includeDefaults"), "false");
    assert.doesNotMatch(url.toString(), /latlng|secret-key/);
    return new Response(JSON.stringify([stream("time", [0, 10]), stream("watts", [200, 200]), stream("latlng", [35, 36])]), {
      headers: { "Content-Type": "application/json" }
    });
  };
  const client = new IntervalsClient("secret-key", "https://intervals.example/api/v1", 1000, fakeFetch);
  const result = summarizeStreams("i123", await client.activityStreams("i123"));
  assert.doesNotMatch(JSON.stringify(result), /latlng|latitude|longitude|secret-key/);
});

test("averages are weighted by irregular elapsed times rather than sample count", () => {
  const result = summarizeStreams("i1", [stream("time", [0, 10, 30]), stream("watts", [100, 200, 300])]);
  assert.equal(result.buckets[0]?.powerWatts.mean, 166.67);
  assert.equal(result.buckets[0]?.powerWatts.coveredSeconds, 30);
  assert.equal(result.buckets[0]?.powerWatts.max, 200);
});

test("clipping and bucket boundaries preserve zeros, units and prorated changes", () => {
  const raw = [
    stream("time", [0, 4, 10]), stream("watts", [0, 100, 300]), stream("heartrate", [0, 140, 160]),
    stream("velocity_smooth", [0, 2, 3]), stream("distance", [0, 40, 100]),
    stream("altitude", [-10, -6, 0]), stream("moving", [false, true, true])
  ];
  const whole = summarizeStreams("i1", raw, { bucketSeconds: 5 });
  assert.equal(whole.buckets[0]?.powerWatts.mean, 20);
  assert.equal(whole.buckets[0]?.powerWatts.min, 0);
  assert.equal(whole.buckets[0]?.heartRateBpm.mean, 140);
  assert.equal(whole.buckets[0]?.heartRateBpm.coveredSeconds, 1);
  assert.equal(whole.buckets[1]?.speedKmh.mean, 7.2);
  assert.equal(whole.buckets[0]?.distanceMeters, 50);
  assert.equal(whole.buckets[0]?.elevationChangeMeters, 5);
  assert.equal(whole.buckets[0]?.movingSeconds, 1);
  const clipped = summarizeStreams("i1", raw, { startSeconds: 2, endSeconds: 8, bucketSeconds: 5 });
  assert.equal(clipped.buckets[0]?.powerWatts.mean, 60);
  assert.equal(clipped.buckets[0]?.distanceMeters, 50);
  assert.equal(clipped.buckets[1]?.distanceMeters, 10);
  assert.equal(clipped.buckets[1]?.endSeconds, 8);
});

test("long gaps and missing or misaligned sensor data are not invented", () => {
  const result = summarizeStreams("i1", [
    stream("time", [0, 10, 100, 110]), stream("watts", [100, null, 0, 0]),
    stream("heartrate", [120, 130]), stream("distance", [0, 10, 5, 15])
  ]);
  assert.equal(result.buckets[0]?.recordedSeconds, 10);
  assert.equal(result.buckets[1]?.recordedSeconds, 10);
  assert.equal(result.buckets[1]?.powerWatts.mean, 0);
  assert.equal(result.buckets[0]?.heartRateBpm.mean, null);
  assert.equal(result.buckets[0]?.cadencePerMinute.mean, null);
  assert.ok(result.unavailableStreams.includes("heartrate"));
  assert.equal(result.buckets.reduce((sum, bucket) => sum + (bucket.distanceMeters ?? 0), 0), 20);
});

test("long activities retain the full range within 180 buckets instead of truncating", () => {
  const time = Array.from({ length: 2161 }, (_, i) => i * 10);
  const result = summarizeStreams("i1", [stream("time", time), stream("watts", time.map(() => 200))]);
  assert.equal(result.buckets.length, 180);
  assert.equal(result.effectiveBucketSeconds, 120);
  assert.equal(result.buckets.at(-1)?.endSeconds, 21600);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.recordedSeconds, 0), 21600);
});

test("missing, unordered and out-of-range time axes fail clearly", () => {
  assert.throws(() => summarizeStreams("i1", []), /時刻データがありません/);
  assert.throws(() => summarizeStreams("i1", [stream("time", [0, 10, 5])]), /順序不正/);
  assert.throws(() => summarizeStreams("i1", [stream("time", [0, 10])], { startSeconds: 20 }), /範囲/);
});
