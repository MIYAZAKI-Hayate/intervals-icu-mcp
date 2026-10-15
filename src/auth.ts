import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AppConfig } from "./config.js";

const REQUIRED_SCOPE = "intervals:read";
export const WRITE_SCOPE = "intervals:write";

class Auth0Verifier implements OAuthTokenVerifier {
  private readonly jwks;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    private readonly allowedSub?: string
  ) {
    this.jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience
    });
    const scopes = extractScopes(payload);
    if (this.allowedSub && payload.sub !== this.allowedSub) throw new Error("User is not allowed");
    return {
      token,
      clientId: typeof payload.azp === "string" ? payload.azp : "unknown",
      scopes,
      expiresAt: payload.exp,
      resource: new URL(this.audience),
      extra: { subject: payload.sub }
    };
  }
}

function extractScopes(payload: JWTPayload): string[] {
  const fromScope = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
  const permissions = Array.isArray(payload.permissions)
    ? payload.permissions.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([...fromScope, ...permissions])];
}

export function authMiddleware(config: AppConfig): RequestHandler {
  if (config.authMode === "none") return (_req, _res, next) => next();
  const verifier = new Auth0Verifier(
    config.auth0Issuer!,
    config.resourceUrl!,
    config.auth0AllowedSub
  );
  return requireBearerAuth({
    verifier,
    requiredScopes: [REQUIRED_SCOPE],
    resourceMetadataUrl: `${config.resourceUrl}/.well-known/oauth-protected-resource`
  });
}

export function toolSecuritySchemes(config: AppConfig, write = false) {
  return config.authMode === "auth0"
    ? ([{ type: "oauth2", scopes: write ? [REQUIRED_SCOPE, WRITE_SCOPE] : [REQUIRED_SCOPE] }] as const)
    : ([{ type: "noauth" }] as const);
}

export function protectedResourceMetadata(config: AppConfig) {
  if (config.authMode !== "auth0") return null;
  return {
    resource: config.resourceUrl,
    authorization_servers: [config.auth0Issuer],
    scopes_supported: config.calendarWriteEnabled ? [REQUIRED_SCOPE, WRITE_SCOPE] : [REQUIRED_SCOPE],
    resource_name: "Intervals.icu Training"
  };
}

export function calendarWriteAuthError(config: AppConfig, authInfo?: AuthInfo) {
  if (config.authMode === "none" || authInfo?.scopes.includes(WRITE_SCOPE)) return null;
  return {
    isError: true,
    content: [{ type: "text" as const, text: "予定の登録・修正には intervals:write 権限で再接続してください。" }],
    _meta: {
      "mcp/www_authenticate": [
        `Bearer resource_metadata="${config.resourceUrl}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="Calendar write permission required", scope="${REQUIRED_SCOPE} ${WRITE_SCOPE}"`
      ]
    }
  };
}
