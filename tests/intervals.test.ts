import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient, sanitizeActivityDetail, sanitizePlannedWorkout } from "../src/intervals.js";

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

test("retrieves planned workouts without returning attached workout files", async () => {
  let requestedUrl = "";
  const fakeFetch: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([{
      id: 123, category: "WORKOUT", type: "Ride", name: "Tempo",
      start_date_local: "2026-10-16T07:00:00", description: "2h with tempo blocks",
      moving_time: 7200, distance: 60000, icu_training_load: 90,
      file_contents_base64: "private-file", workout_file_base64: "private-file",
      workout_doc: { duration: 7200, steps: [{ power: 200 }] }
    }]), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const client = new IntervalsClient("test-key", "https://intervals.example/api/v1", 1000, fakeFetch);
  const workouts = (await client.plannedWorkouts("2026-10-16", "2026-10-22")).map(sanitizePlannedWorkout);
  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/api/v1/athlete/0/events");
  assert.equal(url.searchParams.get("category"), "WORKOUT");
  assert.equal(url.searchParams.get("oldest"), "2026-10-16");
  assert.equal(workouts[0]?.plannedDurationMinutes, 120);
  assert.equal(workouts[0]?.plannedDistanceKm, 60);
  assert.doesNotMatch(JSON.stringify(workouts), /private-file|file_contents|workout_doc/);
});
