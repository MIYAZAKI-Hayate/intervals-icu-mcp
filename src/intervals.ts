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

  private async getArray(path: string, query: Record<string, string>): Promise<JsonObject[]> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const response = await this.fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${Buffer.from(`API_KEY:${this.apiKey}`).toString("base64")}`,
        "User-Agent": "intervals-icu-readonly-mcp/1.0"
      },
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!response.ok) throw new IntervalsApiError(response.status);
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw new Error("Intervals.icu returned an unexpected response");
    return value.filter((item): item is JsonObject => typeof item === "object" && item !== null);
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
