import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, config.host, (error?: Error) => {
    if (error) throw error;
    console.log(`Intervals.icu MCP listening on ${config.host}:${config.port} (calendar write: ${config.calendarWriteEnabled ? "enabled" : "disabled"})`);
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Server startup failed");
  process.exit(1);
}
