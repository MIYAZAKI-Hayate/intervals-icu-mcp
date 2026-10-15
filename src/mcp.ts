import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AppConfig } from "./config.js";
import { addDays, japanToday, validateRange } from "./dates.js";
import {
  IntervalsClient,
  sanitizeActivity,
  sanitizeActivityDetail,
  sanitizePlannedWorkout,
  sanitizeWellness,
  type ActivitySummary,
  type PlannedWorkout,
  type WellnessDay
} from "./intervals.js";
import { buildTrainingSummary } from "./summary.js";
import { toolSecuritySchemes } from "./auth.js";
import { plannedWorkoutOutputSchema, registerCalendarWriteTools } from "./calendar.js";
import { streamsResultSchema, summarizeStreams } from "./streams.js";
import { sanitizeSportSettings, sportSettingsSchema } from "./settings.js";

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
  pairedEventId: nullableString,
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
        "指定期間のトライアスロン練習アクティビティを読み取り専用で取得します。pairedEventIdはIntervals.icuで関連付けられたカレンダー予定のIDで、get_planned_workoutsのidと照合できます。nullは関連ID未取得を示し、予定外・未実施と断定しないでください。関連予定が取得期間外の場合もあります。GPS座標と元ファイルは返しません。",
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
        "活動IDを指定し、活動の主要指標とインターバルごとの時間・距離・心拍・パワーを読み取り専用で取得します。pairedEventIdは関連カレンダー予定のIDです。nullから予定外と推測しないでください。GPS座標、元ファイル、時系列の生データは返しません。",
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
    "get_planned_workouts",
    withSecurity({
      title: "Intervals.icu 予定練習取得",
      description:
        "指定期間のカレンダーに登録された予定練習を読み取り専用で取得します。メニュー本文は最大4000文字です。添付ファイルや位置情報は返しません。",
      inputSchema: { oldest: dateSchema, newest: dateSchema },
      outputSchema: {
        oldest: z.string(), newest: z.string(),
        workoutCount: z.number(), workoutsTruncated: z.boolean(),
        workouts: z.array(plannedWorkoutOutputSchema)
      },
      annotations: readOnlyAnnotations
    }),
    async ({ oldest, newest }) => {
      try {
        validateRange(oldest, newest, config.maxRangeDays);
        const raw = await client.plannedWorkouts(oldest, newest);
        const workouts: PlannedWorkout[] = raw.slice(0, 200).map(sanitizePlannedWorkout);
        return textAndData({
          oldest, newest, workoutCount: raw.length,
          workoutsTruncated: raw.length > 200, workouts
        });
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

  server.registerTool("get_activity_streams", withSecurity({
    title: "Intervals.icu 心拍・パワーの時間帯別分析",
    description: "活動IDを指定し、心拍・パワー・ケイデンス・速度・距離・正味の標高変化を時間帯ごとに集計します。最大180区間で全範囲を返します。活動開始からの秒数で範囲を絞れます。GPS座標、絶対標高、元の時系列配列は返しません。平均は時間加重、30秒超の記録の空白は欠測として除外します。",
    inputSchema: {
      activityId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
      startSeconds: z.number().int().min(0).optional().describe("活動開始からの経過秒数。省略時は全体の開始"),
      endSeconds: z.number().int().min(1).optional().describe("活動開始からの経過秒数。省略時は最後の記録時刻"),
      bucketSeconds: z.number().int().min(5).max(3600).default(60).describe("希望する集計間隔。長い活動では180区間以内に収まるよう広げる")
    },
    outputSchema: streamsResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }), async ({ activityId, startSeconds, endSeconds, bucketSeconds }) => {
    try {
      if (startSeconds !== undefined && endSeconds !== undefined && endSeconds <= startSeconds) {
        throw new Error("終了秒は開始秒より後を指定してください。");
      }
      return textAndData(summarizeStreams(activityId, await client.activityStreams(activityId), { startSeconds, endSeconds, bucketSeconds }));
    } catch (error) { return toolError(error); }
  });

  registerCalendarWriteTools(server, config, client);
  server.registerTool("get_sport_settings", withSecurity({
    title: "Intervals.icu 種目別設定の取得",
    description: "現在の種目別FTP・屋内FTP・閾値心拍・最大心拍・閾値ペース・ゾーン設定を読み取り専用で取得します。sport省略時は全設定グループを返します。共有設定のsportsを確認してください。パワー境界はFTP比%、心拍はbpm、ペース境界は閾値速度比%です。適用期間や過去の設定は取得できず、updatedAtは適用開始日ではありません。カスタムゾーンの定義は含みません。",
    inputSchema: { sport: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/).optional().describe("Run, Ride, Swim, VirtualRide等。設定のsportsに完全一致する種目で絞る") },
    outputSchema: { retrievedAt: z.string(), settings: z.array(sportSettingsSchema), notes: z.array(z.string()) },
    annotations: readOnlyAnnotations
  }), async ({ sport }) => {
    try {
      const settings = (await client.sportSettings()).map(sanitizeSportSettings)
        .filter((setting) => sport === undefined || setting.sports.includes(sport));
      return textAndData({ retrievedAt: new Date().toISOString(), settings, notes: [
        "現在の設定です。適用開始・終了日と履歴は取得できません。updatedAtは更新日時であり適用開始日ではありません。",
        "ゾーン境界と名前はAPIの配列をそのままの順序で返します。上限の番兵値を含む場合があり、最終ゾーンや欠測項目を推測しないでください。",
        "threshold_paceは速度(m/s)として取得し、秒/kmと秒/100mに換算しています。ペースゾーンの%は時間ペースではなく速度の比率です。",
        "カスタムゾーン定義は含みません。settingsが空の場合は一致する設定が取得されていません。"
      ] });
    } catch (error) { return toolError(error); }
  });
  return server;
}
