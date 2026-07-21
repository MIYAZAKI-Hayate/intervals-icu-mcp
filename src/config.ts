export type AuthMode = "none" | "auth0";

export type AppConfig = {
  intervalsApiKey: string;
  intervalsBaseUrl: string;
  intervalsTimeoutMs: number;
  maxRangeDays: number;
  host: string;
  port: number;
  authMode: AuthMode;
  resourceUrl?: string;
  auth0Issuer?: string;
  auth0AllowedSub?: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(): AppConfig {
  const authMode = (process.env.AUTH_MODE?.trim() || "none") as AuthMode;
  if (authMode !== "none" && authMode !== "auth0") {
    throw new Error("AUTH_MODE must be none or auth0");
  }

  if (
    authMode === "none" &&
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_INSECURE_NOAUTH !== "true"
  ) {
    throw new Error("Production requires AUTH_MODE=auth0. Unsafe no-auth mode was blocked.");
  }

  const resourceUrl = authMode === "auth0" ? normalizedUrl(required("MCP_RESOURCE_URL")) : undefined;
  const auth0Issuer = authMode === "auth0" ? `${normalizedUrl(required("AUTH0_ISSUER"))}/` : undefined;

  return {
    intervalsApiKey: required("INTERVALS_API_KEY"),
    intervalsBaseUrl: normalizedUrl(process.env.INTERVALS_BASE_URL || "https://intervals.icu/api/v1"),
    intervalsTimeoutMs: integer("INTERVALS_TIMEOUT_MS", 15_000, 1_000, 60_000),
    maxRangeDays: integer("MAX_RANGE_DAYS", 120, 7, 366),
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: integer("PORT", 3000, 1, 65_535),
    authMode,
    resourceUrl,
    auth0Issuer,
    auth0AllowedSub: process.env.AUTH0_ALLOWED_SUB?.trim() || undefined
  };
}
