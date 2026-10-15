import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AppConfig } from "./config.js";
import { addDays, japanToday, validateRange } from "./dates.js";
import {
  IntervalsClient,
  sanitizeActivity,
  sanitizeActivityDetail,
  sanitizeWellness,
  type ActivitySummary,
  type WellnessDay
} from "./intervals.js";
import { buildTrainingSummary } from "./summary.js";
import { toolSecuritySchemes } from "./auth.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DDで指定してください");
const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true
};

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
const activityOutputSchema = z.object({
  id: z.string(),
  startDateLocal: nullableString,
  name: nullableString,
  sport: z.string(),
  source: nullableString,
  durationMinutes: nullableNumber,
  distanceKm: nullableNumber,
  elevationGainM: nullableNumber,
  trainingLoad: nullableNumber,
  intensity: nullableNumber,
  averageHeartRate: nullableNumber,
  maxHeartRate: nullableNumber,
  averageWatts: nullableNumber,
  normalizedWatts: nullableNumber,
  calories: nullableNumber,
  availabilityNote: nullableString
});
const intervalOutputSchema = z.object({
  type: nullableString,
  startSeconds: nullableNumber,
  endSeconds: nullableNumber,
  durationMinutes: nullableNumber,
  distanceKm: nullableNumber,
  speedKmh: nullableNumber,
  paceMinutesPerKm: nullableNumber,
  averageHeartRate: nullableNumber,
  maxHeartRate: nullableNumber,
  averageWatts: nullableNumber,
  normalizedWatts: nullableNumber,
  averageCadence: nullableNumber,
  intensity: nullableNumber,
  trainingLoad: nullableNumber
});
const activityDetailOutputSchema = activityOutputSchema.extend({
  intervalCount: z.number(),
  intervalsTruncated: z.boolean(),
  intervals: z.array(intervalOutputSchema)
});
const wellnessOutputSchema = z.object({
  date: z.string(),
  ctl: nullableNumber,
  atl: nullableNumber,
  form: nullableNumber,
  rampRate: nullableNumber,
  dailyLoad: nullableNumber,
  weightKg: nullableNumber,
  restingHeartRate: nullableNumber,
  hrvRmssd: nullableNumber,
  hrvSdnn: nullableNumber,
  sleepHours: nullableNumber,
  sleepScore: nullableNumber,
  averageSleepingHeartRate: nullableNumber,
  soreness: nullableNumber,
  fatigue: nullableNumber,
  stress: nullableNumber,
  mood: nullableNumber,
  motivation: nullableNumber,
  readiness: nullableNumber,
  spo2: nullableNumber,
  vo2max: nullableNumber,
  steps: nullableNumber,
  respiration: nullableNumber,
  injury: nullableString,
  comments: nullableString,
  sportInfo: z.array(
    z.object({ sport: z.string(), eftp: nullableNumber, wPrime: nullableNumber, pMax: nullableNumber })
  )
});
const activitiesResultSchema = {
  oldest: z.string(),
  newest: z.string(),
  activities: z.array(activityOutputSchema)
};
const wellnessResultSchema = {
  oldest: z.string(),
  newest: z.string(),
  wellness: z.array(wellnessOutputSchema)
};
const trainingSummaryResultSchema = {
  period: z.object({ oldest: z.string(), newest: z.string() }),
  totals: z.object({
    activityCount: z.number(),
    durationHours: z.number(),
    distanceKm: z.number(),
    elevationGainM: z.number(),
    trainingLoad: z.number()
  }),
  bySport: z.array(
    z.object({
      sport: z.string(),
      count: z.number(),
      durationHours: z.number(),
      distanceKm: z.number(),
      trainingLoad: z.number()
    })
  ),
  latestWellness: wellnessOutputSchema.nullable(),
  healthCoverage: z.object({
    days: z.number(),
    restingHeartRateDays: z.number(),
    hrvDays: z.number(),
    sleepDays: z.number(),
    readinessDays: z.number()
  }),
  wellnessTrend: z.array(wellnessOutputSchema),
  notes: z.array(z.string())
};

function textAndData(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

export function createIntervalsMcpServer(config: AppConfig, client: IntervalsClient) {
  const server = new McpServer({
    name: "intervals-icu-readonly",
    version: "1.0.0"
  });
  const securitySchemes = toolSecuritySchemes(config);
  // Apps SDK securitySchemes is an MCP extension that is preserved at runtime.
  // This helper also supports SDK releases whose TypeScript type lags the wire format.
  const withSecurity = <T extends object>(options: T) => ({
    ...options,
    securitySchemes,
    _meta: { securitySchemes }
  });

  server.registerTool(
    "get_activities",
    withSecurity({
      title: "Intervals.icu アクティビティ取得",
      description:
        "指定期間のトライアスロン練習アクティビティを読み取り専用で取得します。GPS座標と元ファイルは返しません。",
      inputSchema: { oldest: dateSchema, newest: dateSchema },
      outputSchema: activitiesResultSchema,
      annotations: readOnlyAnnotations
    }),
    async ({ oldest, newest }) => {
      try {
        validateRange(oldest, newest, config.maxRangeDays);
        const activities: ActivitySummary[] = (await client.activities(oldest, newest)).map(sanitizeActivity);
        return textAndData({ oldest, newest, activities });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_activity_detail",
    withSecurity({
      title: "Intervals.icu アクティビティ詳細",
      description:
        "活動IDを指定し、活動の主要指標とインターバルごとの時間・距離・心拍・パワーを読み取り専用で取得します。GPS座標、元ファイル、時系列の生データは返しません。",
      inputSchema: { activityId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "有効な活動IDを指定してください") },
      outputSchema: { activity: activityDetailOutputSchema },
      annotations: readOnlyAnnotations
    }),
    async ({ activityId }) => {
      try {
        const activity = sanitizeActivityDetail(await client.activity(activityId));
        return textAndData({ activity });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_wellness",
    withSecurity({
      title: "Intervals.icu Wellness取得",
      description:
        "指定期間のCTL・ATL・フォーム・負荷・HRV・睡眠など、Intervals.icuに存在するWellnessデータを読み取り専用で取得します。",
      inputSchema: { oldest: dateSchema, newest: dateSchema },
      outputSchema: wellnessResultSchema,
      annotations: readOnlyAnnotations
    }),
    async ({ oldest, newest }) => {
      try {
        validateRange(oldest, newest, config.maxRangeDays);
        const wellness: WellnessDay[] = (await client.wellness(oldest, newest)).map(sanitizeWellness);
        return textAndData({ oldest, newest, wellness });
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_training_summary",
    withSecurity({
      title: "トレーニング状況の要約",
      description:
        "アクティビティとWellnessをまとめ、競技別時間・距離・負荷、最新CTL/ATL/フォーム、健康指標の取得状況を返します。週次計画の見直しに使います。",
      inputSchema: {
        oldest: dateSchema.optional().describe("省略時は日本時間の今日から41日前"),
        newest: dateSchema.optional().describe("省略時は日本時間の今日")
      },
      outputSchema: trainingSummaryResultSchema,
      annotations: readOnlyAnnotations
    }),
    async ({ oldest, newest }) => {
      try {
        const resolvedNewest = newest ?? japanToday();
        const resolvedOldest = oldest ?? addDays(resolvedNewest, -41);
        validateRange(resolvedOldest, resolvedNewest, config.maxRangeDays);
        const [activityRaw, wellnessRaw] = await Promise.all([
          client.activities(resolvedOldest, resolvedNewest),
          client.wellness(resolvedOldest, resolvedNewest)
        ]);
        const summary = buildTrainingSummary(
          resolvedOldest,
          resolvedNewest,
          activityRaw.map(sanitizeActivity),
          wellnessRaw.map(sanitizeWellness)
        );
        return textAndData(summary);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  return server;
}
