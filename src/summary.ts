import type { ActivitySummary, WellnessDay } from "./intervals.js";

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function buildTrainingSummary(
  oldest: string,
  newest: string,
  activities: ActivitySummary[],
  wellness: WellnessDay[]
) {
  const bySportMap = new Map<
    string,
    { count: number; durationMinutes: number; distanceKm: number; trainingLoad: number }
  >();

  for (const activity of activities) {
    const current = bySportMap.get(activity.sport) ?? {
      count: 0,
      durationMinutes: 0,
      distanceKm: 0,
      trainingLoad: 0
    };
    current.count += 1;
    current.durationMinutes += activity.durationMinutes ?? 0;
    current.distanceKm += activity.distanceKm ?? 0;
    current.trainingLoad += activity.trainingLoad ?? 0;
    bySportMap.set(activity.sport, current);
  }

  const bySport = [...bySportMap.entries()]
    .map(([sport, value]) => ({
      sport,
      count: value.count,
      durationHours: round(value.durationMinutes / 60, 2),
      distanceKm: round(value.distanceKm, 2),
      trainingLoad: round(value.trainingLoad)
    }))
    .sort((a, b) => b.durationHours - a.durationHours);

  const latestWellness = [...wellness]
    .filter((day) => day.date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1) ?? null;

  const healthCoverage = {
    days: wellness.length,
    restingHeartRateDays: wellness.filter((x) => x.restingHeartRate !== null).length,
    hrvDays: wellness.filter((x) => x.hrvRmssd !== null || x.hrvSdnn !== null).length,
    sleepDays: wellness.filter((x) => x.sleepHours !== null || x.sleepScore !== null).length,
    readinessDays: wellness.filter((x) => x.readiness !== null).length
  };

  const notes: string[] = [];
  if (activities.some((activity) => activity.availabilityNote?.includes("STRAVA"))) {
    notes.push("Strava由来の一部アクティビティはIntervals.icu APIで詳細を取得できません。");
  }
  if (healthCoverage.hrvDays === 0) notes.push("対象期間のHRVはIntervals.icuにありません。");
  if (healthCoverage.sleepDays === 0) notes.push("対象期間の睡眠データはIntervals.icuにありません。");
  if (healthCoverage.readinessDays === 0) {
    notes.push("Garmin独自のトレーニングレディネスは画像で補完してください。");
  }

  return {
    period: { oldest, newest },
    totals: {
      activityCount: activities.length,
      durationHours: round(sum(activities.map((x) => x.durationMinutes)) / 60, 2),
      distanceKm: round(sum(activities.map((x) => x.distanceKm)), 2),
      elevationGainM: round(sum(activities.map((x) => x.elevationGainM)), 0),
      trainingLoad: round(sum(activities.map((x) => x.trainingLoad)))
    },
    bySport,
    latestWellness,
    healthCoverage,
    wellnessTrend: wellness,
    notes
  };
}
