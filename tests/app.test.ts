import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { IntervalsClient } from "../src/intervals.js";

const baseConfig: AppConfig = {
  intervalsApiKey: "test-key",
  intervalsBaseUrl: "https://intervals.example/api/v1",
  intervalsTimeoutMs: 1000,
  maxRangeDays: 120,
  host: "127.0.0.1",
  port: 3000,
  authMode: "none"
};

function fakeIntervalsClient() {
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const data = url.pathname.endsWith("/activities")
      ? [{ id: "a1", type: "Run", moving_time: 3600, distance: 10000 }]
      : url.pathname.endsWith("/streams.json")
        ? [{ type: "time", data: [0, 10, 20] }, { type: "heartrate", data: [120, 140, 150] }]
      : url.pathname.endsWith("/events")
        ? [{ id: 2, type: "Run", name: "Easy run", start_date_local: "2026-10-16T07:00:00" }]
      : url.pathname.endsWith("/activity/a1")
        ? { id: "a1", type: "Run", moving_time: 3600, distance: 10000, icu_intervals: [] }
        : [{ id: "2026-10-15", ctl: 50, atl: 40 }];
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  return new IntervalsClient("test-key", baseConfig.intervalsBaseUrl, 1000, fakeFetch);
}

test("local MCP endpoint lists read-only tools and returns a training summary", async () => {
  const app = createApp(baseConfig, fakeIntervalsClient());
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  const client = new Client({ name: "integration-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ["get_activities", "get_activity_detail", "get_activity_streams", "get_planned_workouts", "get_training_summary", "get_wellness"]
    );
    assert.ok(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true));

    const result = await client.callTool({
      name: "get_training_summary",
      arguments: { oldest: "2026-10-15", newest: "2026-10-15" }
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { totals: { activityCount: number } }).totals.activityCount, 1);

    const detail = await client.callTool({ name: "get_activity_detail", arguments: { activityId: "a1" } });
    assert.equal(detail.isError, undefined);
    assert.equal((detail.structuredContent as { activity: { id: string } }).activity.id, "a1");

    const streams = await client.callTool({ name: "get_activity_streams", arguments: { activityId: "a1" } });
    assert.equal(streams.isError, undefined);
    assert.equal((streams.structuredContent as { buckets: Array<{ heartRateBpm: { mean: number } }> }).buckets[0]?.heartRateBpm.mean, 130);
    const invalidRange = await client.callTool({ name: "get_activity_streams", arguments: { activityId: "a1", startSeconds: 10, endSeconds: 5 } });
    assert.equal(invalidRange.isError, true);

    const planned = await client.callTool({
      name: "get_planned_workouts",
      arguments: { oldest: "2026-10-16", newest: "2026-10-22" }
    });
    assert.equal(planned.isError, undefined);
    assert.equal((planned.structuredContent as { workouts: Array<{ name: string }> }).workouts[0]?.name, "Easy run");
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("Auth0 mode rejects unauthenticated MCP requests", async () => {
  const config: AppConfig = {
    ...baseConfig,
    authMode: "auth0",
    resourceUrl: "https://mcp.example",
    auth0Issuer: "https://auth.example/"
  };
  const app = createApp(config, fakeIntervalsClient());
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const port = (httpServer.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
  } finally {
    await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
  }
});
