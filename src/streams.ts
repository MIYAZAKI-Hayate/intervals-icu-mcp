import { z } from "zod/v4";
import type { JsonObject } from "./intervals.js";

const MAX_BUCKETS = 180;
const MAX_GAP_SECONDS = 30;
const MAX_SAMPLES = 1_000_000;
const metricNames = ["heartrate", "watts", "cadence", "velocity_smooth"] as const;
const otherNames = ["distance", "altitude", "moving"] as const;
const statsSchema = z.object({ mean: z.number().nullable(), min: z.number().nullable(), max: z.number().nullable(), coveredSeconds: z.number() });
export const streamsResultSchema = {
  activityId: z.string(), sourceSampleCount: z.number(),
  windowStartSeconds: z.number(), windowEndSeconds: z.number(),
  requestedBucketSeconds: z.number(), effectiveBucketSeconds: z.number(), maxGapSeconds: z.number(),
  unavailableStreams: z.array(z.string()), notes: z.array(z.string()),
  buckets: z.array(z.object({
    startSeconds: z.number(), endSeconds: z.number(), recordedSeconds: z.number(), movingSeconds: z.number().nullable(), movingCoveredSeconds: z.number(),
    heartRateBpm: statsSchema, powerWatts: statsSchema, cadencePerMinute: statsSchema, speedKmh: statsSchema,
    distanceMeters: z.number().nullable(), distanceCoveredSeconds: z.number(),
    elevationChangeMeters: z.number().nullable(), elevationCoveredSeconds: z.number()
  }))
};

type Stats = { sum: number; seconds: number; min: number; max: number };
function stats(): Stats { return { sum: 0, seconds: 0, min: Infinity, max: -Infinity }; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function round(value: number, digits = 2) { const scale = 10 ** digits; return Math.round(value * scale) / scale; }
function summarize(value: Stats) {
  return {
    mean: value.seconds ? round(value.sum / value.seconds) : null,
    min: value.seconds ? round(value.min) : null, max: value.seconds ? round(value.max) : null,
    coveredSeconds: round(value.seconds)
  };
}

export function summarizeStreams(activityId: string, raw: JsonObject[], options: {
  startSeconds?: number; endSeconds?: number; bucketSeconds?: number;
} = {}) {
  const timeData = raw.find((stream) => stream.type === "time")?.data;
  if (!Array.isArray(timeData) || timeData.length < 2) {
    throw new Error("集計できる時刻データがありません。活動によってはAPIから時系列データを取得できません。");
  }
  if (timeData.length > MAX_SAMPLES) throw new Error("時系列データが大きすぎます（上限100万点）。");
  const time: number[] = [];
  for (const value of timeData) {
    if (!finite(value) || value < 0 || (time.length > 0 && value <= time[time.length - 1]!)) {
      throw new Error("時刻データが欠損または順序不正のため、安全に集計できません。");
    }
    time.push(value);
  }
  const start = Math.max(options.startSeconds ?? time[0]!, time[0]!);
  const end = Math.min(options.endSeconds ?? time.at(-1)!, time.at(-1)!);
  const requestedBucketSeconds = options.bucketSeconds ?? 60;
  if (!finite(start) || !finite(end) || end <= start) throw new Error("指定された時間範囲に集計できるデータがありません。");
  if (!Number.isInteger(requestedBucketSeconds) || requestedBucketSeconds < 5 || requestedBucketSeconds > 3600) {
    throw new Error("集計間隔は5〜3600秒の整数で指定してください。");
  }
  const width = requestedBucketSeconds * Math.max(1, Math.ceil((end - start) / (MAX_BUCKETS * requestedBucketSeconds)));
  const notes = [
    "平均は経過時間による加重平均。各値は次の記録時刻まで保持し、30秒を超える記録間隔は欠測として除外します。停止時間も含みます。",
    "範囲は開始を含み終了を含みません。最後の記録点から先は推測しません。区間の最大・最小は集計に使った記録値です。",
    "距離・標高変化は隣接点の差を経過時間で配分します。標高変化は正味の増減で、累積獲得標高ではありません。GPS座標と絶対標高は返しません。",
    "ケイデンスは競技により回転数・ストローク数などを表します。心拍・パワーの欠測はゼロに置換しません。"
  ];
  if (width > requestedBucketSeconds) notes.push(`全範囲を最大${MAX_BUCKETS}区間で返すため、集計間隔を${width}秒に広げました。詳細は時間範囲を絞って取得してください。`);
  const streams = new Map<string, unknown[]>();
  const unavailableStreams: string[] = [];
  for (const type of [...metricNames, ...otherNames]) {
    const values = raw.find((stream) => stream.type === type)?.data;
    if (Array.isArray(values) && values.length === time.length) streams.set(type, values);
    else {
      unavailableStreams.push(type);
      if (Array.isArray(values)) notes.push(`${type}は時刻とデータ長が異なるため除外しました。`);
    }
  }
  const buckets = Array.from({ length: Math.ceil((end - start) / width) }, (_, index) => ({
    startSeconds: start + index * width, endSeconds: Math.min(end, start + (index + 1) * width),
    recordedSeconds: 0, movingSeconds: 0, movingCoveredSeconds: 0,
    metrics: metricNames.map(() => stats()), distance: 0, distanceCoveredSeconds: 0,
    elevationChange: 0, elevationCoveredSeconds: 0
  }));
  for (let i = 0; i < time.length - 1; i++) {
    const from = time[i]!; const to = time[i + 1]!; const delta = to - from;
    if (to <= start || from >= end || delta > MAX_GAP_SECONDS) continue;
    const left = Math.max(start, from); const right = Math.min(end, to);
    let index = Math.floor((left - start) / width);
    while (index < buckets.length) {
      const bucket = buckets[index]!;
      const overlap = Math.min(right, bucket.endSeconds) - Math.max(left, bucket.startSeconds);
      if (overlap <= 0) break;
      bucket.recordedSeconds += overlap;
      metricNames.forEach((type, metricIndex) => {
        const sample = streams.get(type)?.[i];
        if (!finite(sample) || sample < 0 || (type === "heartrate" && sample === 0)) return;
        const value = type === "velocity_smooth" ? sample * 3.6 : sample;
        const metric = bucket.metrics[metricIndex]!;
        metric.sum += value * overlap; metric.seconds += overlap;
        metric.min = Math.min(metric.min, value); metric.max = Math.max(metric.max, value);
      });
      const moving = streams.get("moving")?.[i];
      if (typeof moving === "boolean" || moving === 0 || moving === 1) {
        bucket.movingCoveredSeconds += overlap;
        if (moving === true || moving === 1) bucket.movingSeconds += overlap;
      }
      for (const type of ["distance", "altitude"] as const) {
        const values = streams.get(type); const a = values?.[i]; const b = values?.[i + 1];
        if (!finite(a) || !finite(b) || (type === "distance" && (a < 0 || b < a))) continue;
        if (type === "distance") { bucket.distance += (b - a) * overlap / delta; bucket.distanceCoveredSeconds += overlap; }
        else { bucket.elevationChange += (b - a) * overlap / delta; bucket.elevationCoveredSeconds += overlap; }
      }
      index += 1;
    }
  }
  return {
    activityId, sourceSampleCount: time.length, windowStartSeconds: start, windowEndSeconds: end,
    requestedBucketSeconds, effectiveBucketSeconds: width, maxGapSeconds: MAX_GAP_SECONDS,
    unavailableStreams, notes,
    buckets: buckets.map((bucket) => ({
      startSeconds: round(bucket.startSeconds), endSeconds: round(bucket.endSeconds), recordedSeconds: round(bucket.recordedSeconds),
      movingSeconds: bucket.movingCoveredSeconds ? round(bucket.movingSeconds) : null,
      movingCoveredSeconds: round(bucket.movingCoveredSeconds),
      heartRateBpm: summarize(bucket.metrics[0]!), powerWatts: summarize(bucket.metrics[1]!),
      cadencePerMinute: summarize(bucket.metrics[2]!), speedKmh: summarize(bucket.metrics[3]!),
      distanceMeters: bucket.distanceCoveredSeconds ? round(bucket.distance) : null,
      distanceCoveredSeconds: round(bucket.distanceCoveredSeconds),
      elevationChangeMeters: bucket.elevationCoveredSeconds ? round(bucket.elevationChange) : null,
      elevationCoveredSeconds: round(bucket.elevationCoveredSeconds)
    }))
  };
}
