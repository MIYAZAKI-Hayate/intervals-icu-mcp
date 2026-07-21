import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeActivity, sanitizeWellness } from "../src/intervals.js";
import { buildTrainingSummary } from "../src/summary.js";

test("sanitizes and summarizes activity and wellness data", () => {
  const activities = [
    sanitizeActivity({
      id: "a1",
      start_date_local: "2026-07-21T19:29:45",
      type: "Ride",
      source: "GARMIN_CONNECT",
      moving_time: 7200,
      distance: 60000,
      total_elevation_gain: 800,
      icu_training_load: 90
    }),
    sanitizeActivity({
      id: "a2",
      start_date_local: "2026-07-22T06:00:00",
      type: "Run",
      moving_time: 3600,
      distance: 10000,
      icu_training_load: 55
    })
  ];
  const wellness = [
    sanitizeWellness({
      id: "2026-07-22",
      ctl: 50,
      atl: 40,
      ctlLoad: 0,
      hrv: 44,
      sleepSecs: 25200
    })
  ];

  const summary = buildTrainingSummary("2026-07-21", "2026-07-22", activities, wellness);
  assert.deepEqual(summary.totals, {
    activityCount: 2,
    durationHours: 3,
    distanceKm: 70,
    elevationGainM: 800,
    trainingLoad: 145
  });
  assert.equal(summary.latestWellness?.form, 10);
  assert.equal(summary.healthCoverage.hrvDays, 1);
  assert.equal(summary.healthCoverage.sleepDays, 1);
});

test("notes Strava API placeholders and missing health fields", () => {
  const activities = [
    sanitizeActivity({
      id: "19401166977",
      source: "STRAVA",
      _note: "STRAVA activities are not available via the API"
    })
  ];
  const wellness = [sanitizeWellness({ id: "2026-07-22", ctl: 48.7, atl: 38.3 })];
  const summary = buildTrainingSummary("2026-07-22", "2026-07-22", activities, wellness);
  assert.equal(summary.notes.length, 4);
  assert.match(summary.notes[0]!, /Strava/);
});
