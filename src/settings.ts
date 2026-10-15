import { z } from "zod/v4";
import type { JsonObject } from "./intervals.js";

const n = z.number().nullable();
const s = z.string().nullable();
const zone = z.object({ boundaries: z.array(n).nullable(), names: z.array(s).nullable(), unit: z.string() });
export const sportSettingsSchema = z.object({
  id: s, sports: z.array(z.string()), ftpWatts: n, indoorFtpWatts: n,
  thresholdHeartRateBpm: n, maxHeartRateBpm: n,
  thresholdSpeedMps: n, thresholdSecondsPerKm: n, thresholdSecondsPer100m: n,
  paceDisplayUnits: s, powerZones: zone, heartRateZones: zone, paceZones: zone,
  trainingLoadPriority: s, workoutTargetPriority: s, updatedAt: s,
  effectiveFrom: z.null(), effectiveTo: z.null()
});

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function positive(value: unknown): number | null {
  const v = number(value);
  return v !== null && v > 0 ? v : null;
}
function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function zones(raw: JsonObject, field: string, names: string, unit: string) {
  return {
    // Preserve positions and upstream sentinel values; do not invent zone ranges or names.
    boundaries: Array.isArray(raw[field]) ? raw[field].map(number) : null,
    names: Array.isArray(raw[names]) ? raw[names].map(string) : null,
    unit
  };
}
export function sanitizeSportSettings(raw: JsonObject) {
  const speed = positive(raw.threshold_pace);
  return {
    id: typeof raw.id === "number" && Number.isFinite(raw.id) ? String(raw.id) : string(raw.id),
    sports: Array.isArray(raw.types) ? raw.types.filter((v): v is string => typeof v === "string") : [],
    ftpWatts: positive(raw.ftp), indoorFtpWatts: positive(raw.indoor_ftp),
    thresholdHeartRateBpm: positive(raw.lthr), maxHeartRateBpm: positive(raw.max_hr),
    thresholdSpeedMps: speed,
    thresholdSecondsPerKm: speed === null ? null : 1000 / speed,
    thresholdSecondsPer100m: speed === null ? null : 100 / speed,
    paceDisplayUnits: string(raw.pace_units),
    powerZones: zones(raw, "power_zones", "power_zone_names", "percent_of_ftp"),
    heartRateZones: zones(raw, "hr_zones", "hr_zone_names", "bpm"),
    paceZones: zones(raw, "pace_zones", "pace_zone_names", "percent_of_threshold_speed"),
    trainingLoadPriority: string(raw.load_order), workoutTargetPriority: string(raw.workout_order),
    updatedAt: string(raw.updated), effectiveFrom: null, effectiveTo: null
  };
}
