import test from "node:test";
import assert from "node:assert/strict";
import { IntervalsClient } from "../src/intervals.js";
import { sanitizeSportSettings, sportSettingsSchema } from "../src/settings.js";

test("settings request reads only the sport settings endpoint", async () => {
  const client = new IntervalsClient("secret", "https://example.test/api/v1", 1000, async (url, init) => {
    assert.equal(String(url), "https://example.test/api/v1/athlete/0/sport-settings");
    assert.equal(init?.method, "GET");
    return Response.json([{ id: 1, types: ["Ride", "VirtualRide"] }]);
  });
  assert.equal((await client.sportSettings()).length, 1);
  const invalid = new IntervalsClient("secret", "https://example.test/api/v1", 1000, async () => Response.json({}));
  await assert.rejects(invalid.sportSettings(), /unexpected response/);
});

test("settings preserve zone units, shared sports and sentinel boundaries without exposing other fields", () => {
  const output = sanitizeSportSettings({ id: 1, types: ["Ride", "VirtualRide"], ftp: 211, indoor_ftp: 200,
    lthr: 170, max_hr: 190, threshold_pace: 4, pace_units: "MINS_KM",
    power_zones: [55, 75, 90], power_zone_names: ["Recovery", "Endurance"],
    hr_zones: [130, 150, 190], pace_zones: [80, 100, 999],
    updated: "2026-10-15T00:00:00Z", athlete_id: "private", icu_api_key: "secret", custom_field_values: { private: true }
  });
  sportSettingsSchema.parse(output);
  assert.deepEqual(output.sports, ["Ride", "VirtualRide"]);
  assert.equal(output.ftpWatts, 211);
  assert.equal(output.indoorFtpWatts, 200);
  assert.equal(output.thresholdSecondsPerKm, 250);
  assert.equal(output.thresholdSecondsPer100m, 25);
  assert.equal(output.powerZones.unit, "percent_of_ftp");
  assert.deepEqual(output.powerZones.boundaries, [55, 75, 90]);
  assert.equal(output.heartRateZones.unit, "bpm");
  assert.deepEqual(output.paceZones.boundaries, [80, 100, 999]);
  assert.equal(output.effectiveFrom, null);
  assert.ok(!JSON.stringify(output).includes("secret"));
  assert.ok(!JSON.stringify(output).includes("private"));
});

test("missing and invalid settings remain missing, and swim pace converts from speed", () => {
  const missing = sanitizeSportSettings({ ftp: 0, indoor_ftp: -1, threshold_pace: 0, max_hr: Number.NaN,
    hr_zones: [130, null, "150"], hr_zone_names: ["Z1", null, 3] });
  sportSettingsSchema.parse(missing);
  assert.equal(missing.ftpWatts, null);
  assert.equal(missing.thresholdSecondsPerKm, null);
  assert.equal(missing.powerZones.boundaries, null);
  assert.deepEqual(missing.heartRateZones.boundaries, [130, null, null]);
  assert.equal(missing.updatedAt, null);
  const swim = sanitizeSportSettings({ types: ["Swim"], threshold_pace: 1.25, pace_units: "SECS_100M" });
  assert.equal(swim.thresholdSecondsPer100m, 80);
  assert.equal(swim.thresholdSecondsPerKm, 800);
});
