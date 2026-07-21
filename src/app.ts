import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "./config.js";
import { authMiddleware, protectedResourceMetadata } from "./auth.js";
import { IntervalsClient } from "./intervals.js";
import { createIntervalsMcpServer } from "./mcp.js";

export function createApp(config: AppConfig, client?: IntervalsClient) {
  const app = createMcpExpressApp();
  const intervals =
    client ??
    new IntervalsClient(
      config.intervalsApiKey,
      config.intervalsBaseUrl,
      config.intervalsTimeoutMs
    );

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", authMode: config.authMode });
  });

  const metadata = protectedResourceMetadata(config);
  if (metadata) {
    app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
      res.json(metadata);
    });
  }

  app.post("/mcp", authMiddleware(config), async (req, res) => {
    const server = createIntervalsMcpServer(config, intervals);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed", error instanceof Error ? error.message : "unknown error");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  });
  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  });

  return app;
}
