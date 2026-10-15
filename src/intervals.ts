import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export class IntervalsApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? "Intervals.icu authentication failed" : `Intervals.icu request failed (${status})`);
  }
}

export class IntervalsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async activities(oldest: string, newest: string): Promise<JsonObject[]> {
    return this.getArray("/athlete/0/activities", { oldest, newest });
  }

  async wellness(oldest: string, newest: string): Promise<JsonObject[]> {
    return this.getArray("/athlete/0/wellness", { oldest, newest });
  }

  async plannedWorkouts(oldest: string, newest: string): Promise<JsonObject[]> {
    return this.getArray("/athlete/0/events", { oldest, newest, category: "WORKOUT" });
  }

  async plannedWorkout(id: string): Promise<JsonObject> {
    return this.getObject(`/athlete/0/events/${encodeURIComponent(id)}`, {});
  }

  async createPlannedWorkout(payload: JsonObject): Promise<JsonObject> {
    return this.getObject("/athlete/0/events", { upsertOnUid: "false" }, "POST", payload);
  }

  async updatePlannedWorkout(id: string, payload: JsonObject): Promise<JsonObject> {
    return this.getObject(`/athlete/0/events/${encodeURIComponent(id)}`, {}, "PUT", payload);
  }

  private async getObject(path: string, query: Record<string, string>, method = "GET", payload?: JsonObject): Promise<JsonObject> {
    const value = await this.getJson(path, query, method, payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Intervals.icu returned an unexpected event response");
    }
    return value as JsonObject;
  }

  async activity(id: string): Promise<JsonObject> {
    const value = await this.getJson(`/activity/${encodeURIComponent(id)}`, { intervals: "true" });
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Intervals.icu returned an unexpected activity response");
    }
    return value as JsonObject;
  }

  private async getArray(path: string, query: Record<string, string>): Promise<JsonObject[]> {
    const value = await this.getJson(path, query);
    if (!Array.isArray(value)) throw new Error("Intervals.icu returned an unexpected response");
    return value.filter((item): item is JsonObject => typeof item === "object" && item !== null);
  }

  private async getJson(path: string, query: Record<string, string>, method = "GET", payload?: JsonObject): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
          Authorization: `Basic ${Buffer.from(`API_KEY:${this.apiKey}`).toString("base64")}`,
          "User-Agent": "intervals-icu-readonly-mcp/1.0"
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      if (method !== "GET") {
        throw new Error("保存結果を確認できません。重複を避けるため、再実行前にカレンダーを再取得してください。");
      }
      throw error;
    }

    if (!response.ok && method !== "GET" && response.status >= 500) {
      throw new Error("保存結果を確認できません。再実行前にカレンダーを再取得してください。");
    }
    if (!response.ok) throw new IntervalsApiError(response.status);
    try {
      return await response.json() as unknown;
    } catch (error) {
      if (method !== "GET") {
        throw new Error("保存結果を確認できません。再実行前にカレンダーを再取得してください。");
      }
      throw error;
    }
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rounded(value: number | null, digits = 1): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export type ActivitySummary = ReturnType<typeof sanitizeActivity>;
export type WellnessDay = ReturnType<typeof sanitizeWellness>;
export type PlannedWorkout = ReturnType<typeof sanitizePlannedWorkout>;

export function plannedWorkoutRevision(raw: JsonObject): string {
  // Use fields present in both list and single-event responses, including the upstream revision.
  const fields = ["id", "updated", "category", "start_date_local", "end_date_local", "type", "name", "description"];
  return createHash("sha256").update(JSON.stringify(fields.map((key) => raw[key] ?? null))).digest("hex");
}

export function sanitizePlannedWorkout(raw: JsonObject) {
  const workoutDoc = typeof raw.workout_doc === "object" && raw.workout_doc !== null && !Array.isArray(raw.workout_doc)
    ? raw.workout_doc as JsonObject
    : null;
  const durationSeconds = numberOrNull(raw.moving_time) ?? numberOrNull(workoutDoc?.duration);
  const distance = numberOrNull(raw.distance) ?? numberOrNull(workoutDoc?.distance);
  const description = stringOrNull(raw.description);
  return {
    id: String(raw.id ?? ""),
    revision: plannedWorkoutRevision(raw),
    startDateLocal: stringOrNull(raw.start_date_local),
    sport: stringOrNull(raw.type) ?? "Unknown",
    name: stringOrNull(raw.name),
    description: description?.slice(0, 4000) ?? null,
    descriptionTruncated: description !== null && description.length > 4000,
    plannedDurationMinutes: durationSeconds === null ? null : rounded(durationSeconds / 60, 1),
    plannedDistanceKm: distance === null ? null : rounded(distance / 1000, 2),
    plannedTrainingLoad: rounded(numberOrNull(raw.icu_training_load) ?? numberOrNull(raw.training_load))
  };
}

export function sanitizeActivity(raw: JsonObject) {
  const seconds = numberOrNull(raw.moving_time) ?? numberOrNull(raw.elapsed_time);
  const distance = numberOrNull(raw.distance);
  return {
    id: String(raw.id ?? ""),
    startDateLocal: stringOrNull(raw.start_date_local),
    name: stringOrNull(raw.name),
    sport: stringOrNull(raw.type) ?? stringOrNull(raw.sport) ?? "Unknown",
    source: stringOrNull(raw.source),
    durationMinutes: seconds === null ? null : rounded(seconds / 60),
    distanceKm: distance === null ? null : rounded(distance / 1000, 2),
    elevationGainM: rounded(numberOrNull(raw.total_elevation_gain)),
    trainingLoad: rounded(numberOrNull(raw.icu_training_load) ?? numberOrNull(raw.training_load)),
    intensity: rounded(numberOrNull(raw.icu_intensity), 3),
    averageHeartRate: rounded(numberOrNull(raw.average_heartrate)),
    maxHeartRate: rounded(numberOrNull(raw.max_heartrate)),
    averageWatts: rounded(numberOrNull(raw.average_watts)),
    normalizedWatts: rounded(
      numberOrNull(raw.weighted_average_watts) ?? numberOrNull(raw.normalized_power)
    ),
    calories: rounded(numberOrNull(raw.calories), 0),
    availabilityNote: stringOrNull(raw._note)
  };
}

export function sanitizeWellness(raw: JsonObject) {
  const ctl = numberOrNull(raw.ctl);
  const atl = numberOrNull(raw.atl);
  const sleepSecs = numberOrNull(raw.sleepSecs);
  const sportInfo = Array.isArray(raw.sportInfo)
    ? raw.sportInfo
        .filter((item): item is JsonObject => typeof item === "object" && item !== null)
        .map((item) => ({
          sport: stringOrNull(item.type) ?? "Unknown",
          eftp: rounded(numberOrNull(item.eftp)),
          wPrime: rounded(numberOrNull(item.wPrime)),
          pMax: rounded(numberOrNull(item.pMax))
        }))
    : [];

  return {
    date: String(raw.id ?? ""),
    ctl: rounded(ctl, 2),
    atl: rounded(atl, 2),
    form: ctl === null || atl === null ? null : rounded(ctl - atl, 2),
    rampRate: rounded(numberOrNull(raw.rampRate), 2),
    dailyLoad: rounded(numberOrNull(raw.ctlLoad) ?? numberOrNull(raw.atlLoad)),
    weightKg: rounded(numberOrNull(raw.weight)),
    restingHeartRate: rounded(numberOrNull(raw.restingHR)),
    hrvRmssd: rounded(numberOrNull(raw.hrv)),
    hrvSdnn: rounded(numberOrNull(raw.hrvSDNN)),
    sleepHours: sleepSecs === null ? null : rounded(sleepSecs / 3600, 2),
    sleepScore: rounded(numberOrNull(raw.sleepScore)),
    averageSleepingHeartRate: rounded(numberOrNull(raw.avgSleepingHR)),
    soreness: rounded(numberOrNull(raw.soreness)),
    fatigue: rounded(numberOrNull(raw.fatigue)),
    stress: rounded(numberOrNull(raw.stress)),
    mood: rounded(numberOrNull(raw.mood)),
    motivation: rounded(numberOrNull(raw.motivation)),
    readiness: rounded(numberOrNull(raw.readiness)),
    spo2: rounded(numberOrNull(raw.spO2)),
    vo2max: rounded(numberOrNull(raw.vo2max)),
    steps: rounded(numberOrNull(raw.steps), 0),
    respiration: rounded(numberOrNull(raw.respiration)),
    injury: stringOrNull(raw.injury),
    comments: stringOrNull(raw.comments),
    sportInfo
  };
}

const MAX_INTERVALS = 200;

export function sanitizeActivityDetail(raw: JsonObject) {
  const source = Array.isArray(raw.icu_intervals) ? raw.icu_intervals : [];
  const intervals = source
    .filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item))
    .slice(0, MAX_INTERVALS)
    .map((item) => {
      const speed = numberOrNull(item.average_speed);
      const distance = numberOrNull(item.distance);
      const duration = numberOrNull(item.moving_time) ?? numberOrNull(item.elapsed_time);
      return {
        type: stringOrNull(item.type),
        startSeconds: rounded(numberOrNull(item.start_time), 0),
        endSeconds: rounded(numberOrNull(item.end_time), 0),
        durationMinutes: duration === null ? null : rounded(duration / 60, 2),
        distanceKm: distance === null ? null : rounded(distance / 1000, 3),
        speedKmh: speed === null ? null : rounded(speed * 3.6, 2),
        paceMinutesPerKm: speed === null || speed <= 0 ? null : rounded(1000 / speed / 60, 2),
        averageHeartRate: rounded(numberOrNull(item.average_heartrate)),
        maxHeartRate: rounded(numberOrNull(item.max_heartrate)),
        averageWatts: rounded(numberOrNull(item.average_watts)),
        normalizedWatts: rounded(numberOrNull(item.weighted_average_watts)),
        averageCadence: rounded(numberOrNull(item.average_cadence)),
        intensity: rounded(numberOrNull(item.intensity), 2),
        trainingLoad: rounded(numberOrNull(item.training_load), 2)
      };
    });
  return {
    ...sanitizeActivity(raw),
    intervalCount: source.length,
    intervalsTruncated: source.length > MAX_INTERVALS,
    intervals
  };
}
