import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AppConfig } from "./config.js";
import { calendarWriteAuthError, toolSecuritySchemes } from "./auth.js";
import { IntervalsApiError, IntervalsClient, plannedWorkoutRevision, sanitizePlannedWorkout, type JsonObject } from "./intervals.js";

export const plannedWorkoutOutputSchema = z.object({
  id: z.string(), revision: z.string(), startDateLocal: z.string().nullable(),
  sport: z.string(), name: z.string().nullable(), description: z.string().nullable(),
  descriptionTruncated: z.boolean(), plannedDurationMinutes: z.number().nullable(),
  plannedDistanceKm: z.number().nullable(), plannedTrainingLoad: z.number().nullable()
});

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  .refine((value) => {
    const time = new Date(`${value}Z`);
    return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 19) === value;
  }, "実在するローカル日時を YYYY-MM-DDTHH:mm:ss で指定してください");
const workoutFields = {
  startDateLocal: localDateTime.describe("Intervals.icuのローカル日時。終日の予定は日付にT00:00:00を付ける"),
  sport: z.enum(["Ride", "VirtualRide", "Run", "VirtualRun", "TrailRun", "Swim", "OpenWaterSwim", "WeightTraining", "Other"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000).describe("ユーザーが登録・修正を依頼したメニュー本文。Intervals.icuのワークアウト記法も利用可")
};
const changesSchema = z.object(workoutFields).partial().strict()
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), "変更する項目を1つ以上指定してください");
const writes = new WeakMap<IntervalsClient, Promise<unknown>>();

// Serializes this process's calendar writes. The upstream API does not provide atomic compare-and-swap.
function serializeWrite<T>(client: IntervalsClient, work: () => Promise<T>): Promise<T> {
  const pending = (writes.get(client) ?? Promise.resolve()).then(work);
  writes.set(client, pending.catch(() => undefined));
  return pending;
}

function payloadFor(changes: z.infer<typeof changesSchema>): JsonObject {
  const payload: JsonObject = {};
  if (changes.startDateLocal !== undefined) payload.start_date_local = changes.startDateLocal;
  if (changes.sport !== undefined) payload.type = changes.sport;
  if (changes.name !== undefined) payload.name = changes.name;
  if (changes.description !== undefined) payload.description = changes.description;
  return payload;
}

function result(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "予定の保存に失敗しました" }] };
}

function assertWorkout(raw: JsonObject, eventId?: string) {
  if (raw.category !== "WORKOUT" || !/^\d+$/.test(String(raw.id ?? "")) || (eventId && String(raw.id) !== eventId)) {
    throw new Error("対象の予定練習を確認できません。カレンダーを再取得してください。");
  }
}

export function registerCalendarWriteTools(server: McpServer, config: AppConfig, client: IntervalsClient) {
  if (!config.calendarWriteEnabled) return;
  const securitySchemes = toolSecuritySchemes(config, true);
  const security = { securitySchemes, _meta: { securitySchemes } };

  server.registerTool("delete_planned_workout", {
    ...security,
    title: "Intervals.icu 予定練習の削除",
    description: "ユーザーが削除を依頼した予定練習を1件だけ削除します。最新の予定一覧で名前・日時をユーザーに示し、削除対象を確認してから実行してください。取得時のIDとrevisionが必要です。変更済み・編集禁止の予定は拒否し、関連予定は削除しません。削除後に対象の不在を再取得で確認します。通信失敗時は予定を再取得し、自動で再実行しないでください。",
    inputSchema: {
      eventId: z.string().regex(/^[1-9]\d{0,9}$/),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("最新のget_planned_workoutsで取得した対象予定のrevision")
    },
    outputSchema: { deletedWorkout: plannedWorkoutOutputSchema, deletionVerified: z.literal(true) },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false }
  }, async ({ eventId, expectedRevision }, extra) => {
    const denied = calendarWriteAuthError(config, extra.authInfo);
    if (denied) return denied;
    try {
      return await serializeWrite(client, async () => {
        const previous = await client.plannedWorkout(eventId);
        assertWorkout(previous, eventId);
        if (previous.athlete_cannot_edit === true || previous.structure_read_only === true) {
          throw new Error("この予定は編集が制限されています。Intervals.icuで確認してください。");
        }
        if (plannedWorkoutRevision(previous) !== expectedRevision) {
          throw new Error("取得後に予定が変更されています。最新の予定を読み直してから削除してください。");
        }
        await client.deletePlannedWorkout(eventId);
        try {
          await client.plannedWorkout(eventId);
        } catch (error) {
          if (error instanceof IntervalsApiError && error.status === 404) {
            return result({ deletedWorkout: sanitizePlannedWorkout(previous), deletionVerified: true });
          }
          throw new Error("削除要求後の結果を確認できません。再実行前にカレンダーを再取得してください。");
        }
        throw new Error("削除要求後も対象の予定が存在します。カレンダーを再取得して確認してください。");
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool("create_planned_workout", {
    ...security,
    title: "Intervals.icu 予定練習の登録",
    description: "ユーザーが指定した日時・種目・メニューで予定練習を1件登録します。既存の予定を変更しません。同じ日時・種目・名前があれば重複登録を拒否します。通信失敗時は再実行前に予定一覧を確認してください。",
    inputSchema: workoutFields,
    outputSchema: { workout: plannedWorkoutOutputSchema },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false }
  }, async (input, extra) => {
    const denied = calendarWriteAuthError(config, extra.authInfo);
    if (denied) return denied;
    try {
      return await serializeWrite(client, async () => {
        const date = input.startDateLocal.slice(0, 10);
        const existing = await client.plannedWorkouts(date, date);
        if (existing.some((event) => event.start_date_local === input.startDateLocal && event.type === input.sport && event.name === input.name)) {
          throw new Error("同じ日時・種目・名前の予定が存在します。予定一覧を確認し、変更する場合は修正ツールを使ってください。");
        }
        const raw = await client.createPlannedWorkout({ category: "WORKOUT", ...payloadFor(input) });
        assertWorkout(raw);
        return result({ workout: sanitizePlannedWorkout(raw) });
      });
    } catch (error) { return failure(error); }
  });

  server.registerTool("update_planned_workout", {
    ...security,
    title: "Intervals.icu 予定練習の修正",
    description: "ユーザーが修正を依頼した予定練習1件の指定項目だけを変更します。予定一覧から得たIDとrevisionを使ってください。取得後に変更された予定や編集禁止の予定は拒否します。メニュー本文の指定は全文の置き換えです。",
    inputSchema: {
      eventId: z.string().regex(/^[1-9]\d{0,9}$/),
      expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).describe("get_planned_workoutsが返した対象予定のrevision"),
      changes: changesSchema
    },
    outputSchema: { workout: plannedWorkoutOutputSchema, previousWorkout: plannedWorkoutOutputSchema },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false }
  }, async ({ eventId, expectedRevision, changes }, extra) => {
    const denied = calendarWriteAuthError(config, extra.authInfo);
    if (denied) return denied;
    try {
      return await serializeWrite(client, async () => {
        const previous = await client.plannedWorkout(eventId);
        assertWorkout(previous, eventId);
        if (previous.athlete_cannot_edit === true || previous.structure_read_only === true) {
          throw new Error("この予定は編集が制限されています。Intervals.icuで確認してください。");
        }
        if (plannedWorkoutRevision(previous) !== expectedRevision) {
          throw new Error("取得後に予定が変更されています。最新の予定を読み直してから修正してください。");
        }
        const payload = payloadFor(changes);
        if (changes.startDateLocal && typeof previous.end_date_local === "string") {
          const oldStart = Date.parse(`${previous.start_date_local}Z`);
          const oldEnd = Date.parse(`${previous.end_date_local}Z`);
          const newStart = Date.parse(`${changes.startDateLocal}Z`);
          if (!Number.isFinite(oldStart) || !Number.isFinite(oldEnd)) {
            throw new Error("既存の予定日時を確認できません。Intervals.icuで確認してください。");
          }
          payload.end_date_local = new Date(oldEnd + newStart - oldStart).toISOString().slice(0, 19);
        }
        const raw = await client.updatePlannedWorkout(eventId, payload);
        assertWorkout(raw, eventId);
        return result({ workout: sanitizePlannedWorkout(raw), previousWorkout: sanitizePlannedWorkout(previous) });
      });
    } catch (error) { return failure(error); }
  });
}
