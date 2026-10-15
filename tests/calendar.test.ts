import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { IntervalsClient, plannedWorkoutRevision, type JsonObject } from "../src/intervals.js";
import type { AppConfig } from "../src/config.js";

const input = { startDateLocal: "2026-10-16T07:00:00", sport: "Run", name: "Easy run", description: "- 30m Z2" };
const fixture: JsonObject = {
  id: 123, category: "WORKOUT", start_date_local: input.startDateLocal,
  end_date_local: "2026-10-16T08:00:00", type: "Run", name: input.name,
  description: input.description, updated: "2026-10-15T00:00:00Z", color: "green"
};

function fakeApi(initial: JsonObject[] = []) {
  let events = structuredClone(initial);
  const writes: Array<{ method: string; url: URL; payload: JsonObject }> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const address = new URL(String(url));
    const method = init?.method ?? "GET";
    let response: unknown;
    if (method === "GET") {
      response = address.pathname.endsWith("/events") ? events : events.find((event) => String(event.id) === address.pathname.split("/").at(-1));
    } else {
      const payload = JSON.parse(String(init?.body)) as JsonObject;
      writes.push({ method, url: address, payload });
      if (method === "POST") {
        response = { id: 456, ...payload, updated: "2026-10-15T01:00:00Z" };
        events.push(response as JsonObject);
      } else {
        const id = address.pathname.split("/").at(-1);
        events = events.map((event) => String(event.id) === id ? { ...event, ...payload, updated: "2026-10-15T02:00:00Z" } : event);
        response = events.find((event) => String(event.id) === id);
      }
    }
    return new Response(JSON.stringify(response ?? {}), { headers: { "Content-Type": "application/json" } });
  };
  return { fetchImpl, writes };
}

async function withMcp(fetchImpl: typeof fetch, run: (connect: (scopes?: string[]) => Promise<Client>) => Promise<void>) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
  const jwks = createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  jwks.listen(0, "127.0.0.1");
  await once(jwks, "listening");
  const issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/`;
  const config: AppConfig = {
    intervalsApiKey: "test-key", intervalsBaseUrl: "https://intervals.example/api/v1", intervalsTimeoutMs: 1000,
    maxRangeDays: 120, host: "127.0.0.1", port: 3000, authMode: "auth0",
    auth0Issuer: issuer, auth0AllowedSub: "test-user", resourceUrl: "https://mcp.example", calendarWriteEnabled: true
  };
  const app = createApp(config, new IntervalsClient("test-key", config.intervalsBaseUrl, 1000, fetchImpl));
  const httpServer = app.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const clients: Client[] = [];
  try {
    await run(async (scopes = ["intervals:read", "intervals:write"]) => {
      const token = await new SignJWT({ scope: scopes.join(" "), azp: "test-client" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer)
        .setAudience(config.resourceUrl!).setSubject("test-user").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      const client = new Client({ name: "calendar-test", version: "1.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      }));
      return client;
    });
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await Promise.all([httpServer, jwks].map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

test("valid read-only tokens cannot invoke either calendar write tool", async () => {
  const api = fakeApi([fixture]);
  await withMcp(api.fetchImpl, async (connect) => {
    const client = await connect(["intervals:read"]);
    for (const call of [
      { name: "create_planned_workout", arguments: input },
      { name: "update_planned_workout", arguments: { eventId: "123", expectedRevision: plannedWorkoutRevision(fixture), changes: { name: "New name" } } }
    ]) {
      const response = await client.callTool(call);
      assert.equal(response.isError, true);
      assert.match(JSON.stringify(response._meta), /insufficient_scope/);
    }
    assert.equal(api.writes.length, 0);
  });
});

test("write-authorized tools create and update one workout using only specified fields", async () => {
  const api = fakeApi([fixture]);
  await withMcp(api.fetchImpl, async (connect) => {
    const client = await connect();
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((tool) => tool.name === "create_planned_workout")?.annotations?.readOnlyHint, false);
    assert.equal(tools.find((tool) => tool.name === "update_planned_workout")?.annotations?.destructiveHint, true);
    const creates = await Promise.all([1, 2].map(() => client.callTool({
      name: "create_planned_workout", arguments: { ...input, startDateLocal: "2026-10-17T07:00:00" }
    })));
    assert.equal(creates.filter((response) => response.isError !== true).length, 1);
    assert.equal(creates.filter((response) => response.isError === true).length, 1);
    assert.equal(api.writes[0]?.method, "POST");
    assert.equal(api.writes[0]?.url.searchParams.get("upsertOnUid"), "false");
    assert.equal(api.writes[0]?.payload.category, "WORKOUT");
    const updated = await client.callTool({ name: "update_planned_workout", arguments: {
      eventId: "123", expectedRevision: plannedWorkoutRevision(fixture), changes: { startDateLocal: "2026-10-18T07:00:00", name: "Moved run" }
    } });
    assert.equal(updated.isError, undefined);
    assert.deepEqual(api.writes[1]?.payload, {
      start_date_local: "2026-10-18T07:00:00", end_date_local: "2026-10-18T08:00:00", name: "Moved run"
    });
    assert.equal((updated.structuredContent as { previousWorkout: { name: string } }).previousWorkout.name, "Easy run");
    const duplicate = await client.callTool({ name: "create_planned_workout", arguments: { ...input, startDateLocal: "2026-10-17T07:00:00" } });
    assert.equal(duplicate.isError, true);
    assert.equal(api.writes.length, 2);
  });
});

test("stale revisions, non-workout events and locked plans are refused before PUT", async () => {
  const entries = [fixture, { ...fixture, id: 124, category: "NOTE" }, { ...fixture, id: 125, athlete_cannot_edit: true }];
  const api = fakeApi(entries);
  await withMcp(api.fetchImpl, async (connect) => {
    const client = await connect();
    for (const event of entries) {
      const response = await client.callTool({ name: "update_planned_workout", arguments: {
        eventId: String(event.id), expectedRevision: event.id === 123 ? "0".repeat(64) : plannedWorkoutRevision(event), changes: { name: "Changed" }
      } });
      assert.equal(response.isError, true);
    }
    assert.equal(api.writes.length, 0);
  });
});

test("invalid dates, empty changes and unexpected fields cause no writes", async () => {
  const api = fakeApi([fixture]);
  await withMcp(api.fetchImpl, async (connect) => {
    const client = await connect();
    const invalidDate = await client.callTool({ name: "create_planned_workout", arguments: { ...input, startDateLocal: "2026-02-30T07:00:00" } });
    assert.equal(invalidDate.isError, true);
    for (const changes of [{}, { file_contents_base64: "unexpected" }]) {
      const response = await client.callTool({ name: "update_planned_workout", arguments: { eventId: "123", expectedRevision: plannedWorkoutRevision(fixture), changes } });
      assert.equal(response.isError, true);
    }
    assert.equal(api.writes.length, 0);
  });
});

test("a failed write request is never retried automatically", async () => {
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests += 1; throw new Error("Connection lost"); };
  const client = new IntervalsClient("test-key", "https://intervals.example/api/v1", 1000, fetchImpl);
  await assert.rejects(client.createPlannedWorkout({ category: "WORKOUT" }), /保存結果を確認できません/);
  assert.equal(requests, 1);
});
