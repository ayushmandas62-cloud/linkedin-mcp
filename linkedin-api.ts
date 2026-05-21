import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const REDIRECT_URI =
  process.env.LINKEDIN_REDIRECT_URI ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/callback`
    : "https://linkedin-mcp-production-3d70.up.railway.app/auth/callback");
const TOKEN_FILE = path.join(os.homedir(), ".linkedin-mcp-token.json");

export interface TokenData {
  access_token: string;
  expires_in: number;
  obtained_at: number;
}

export interface LinkedInProfile {
  id: string;
  firstName: string;
  lastName: string;
  headline: string;
  profilePicture?: string;
}

// Module-level singleton state — shared across per-request server instances
let tokenData: TokenData | null = null;
let oauthState: string | null = null;
let pendingOAuthResolve: ((code: string) => void) | null = null;

export async function initializeToken(): Promise<void> {
  try {
    const raw = await fs.readFile(TOKEN_FILE, "utf-8");
    tokenData = JSON.parse(raw) as TokenData;
  } catch {
    tokenData = null;
  }
}

async function persistToken(data: TokenData): Promise<void> {
  tokenData = data;
  await fs.writeFile(TOKEN_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isAuthenticated(): boolean {
  if (!tokenData) return false;
  const expiresAt = tokenData.obtained_at + tokenData.expires_in * 1000;
  return Date.now() < expiresAt;
}

export function generateAuthUrl(clientId: string): string {
  oauthState = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: oauthState,
    scope: "r_liteprofile r_emailaddress w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export function setPendingOAuthResolve(resolve: (code: string) => void): void {
  pendingOAuthResolve = resolve;
}

export function resolveOAuthCallback(code: string, state: string): boolean {
  if (state !== oauthState) return false;
  oauthState = null;
  if (pendingOAuthResolve) {
    pendingOAuthResolve(code);
    pendingOAuthResolve = null;
  }
  return true;
}

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<void> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  await persistToken({
    access_token: data.access_token,
    expires_in: data.expires_in,
    obtained_at: Date.now(),
  });
}

export async function revokeToken(): Promise<void> {
  tokenData = null;
  try {
    await fs.unlink(TOKEN_FILE);
  } catch {}
}

async function apiGet(url: string): Promise<unknown> {
  if (!tokenData) throw new Error("Not authenticated with LinkedIn");
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "X-Restli-Protocol-Version": "2.0.0",
    },
  });
  if (response.status === 401) {
    tokenData = null;
    throw new Error("LinkedIn session expired. Please reconnect using linkedin_connect.");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LinkedIn API ${response.status}: ${text}`);
  }
  return response.json();
}

async function apiPost(url: string, body: object): Promise<unknown> {
  if (!tokenData) throw new Error("Not authenticated with LinkedIn");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(body),
  });
  if (response.status === 401) {
    tokenData = null;
    throw new Error("LinkedIn session expired. Please reconnect using linkedin_connect.");
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LinkedIn API ${response.status}: ${text}`);
  }
  return response.json();
}

function extractLocale(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const localized = (obj as Record<string, unknown>).localized;
  if (!localized || typeof localized !== "object") return "";
  const keys = Object.keys(localized as object);
  if (keys.length === 0) return "";
  return String((localized as Record<string, unknown>)[keys[0]] ?? "");
}

export async function getProfile(): Promise<LinkedInProfile> {
  const data = (await apiGet(
    "https://api.linkedin.com/v2/me?projection=(id,firstName,lastName,headline,profilePicture(displayImage~:playableStreams))"
  )) as Record<string, unknown>;

  let profilePicture: string | undefined;
  try {
    const pic = data.profilePicture as Record<string, unknown> | undefined;
    const display = pic?.["displayImage~"] as Record<string, unknown> | undefined;
    const elements = display?.elements as Array<Record<string, unknown>> | undefined;
    if (elements && elements.length > 0) {
      const last = elements[elements.length - 1];
      const identifiers = last?.identifiers as Array<Record<string, unknown>> | undefined;
      profilePicture = String(identifiers?.[0]?.identifier ?? "");
    }
  } catch {}

  return {
    id: String(data.id ?? ""),
    firstName: extractLocale(data.firstName),
    lastName: extractLocale(data.lastName),
    headline: extractLocale(data.headline),
    profilePicture: profilePicture || undefined,
  };
}

export async function getEmail(): Promise<string> {
  const data = (await apiGet(
    "https://api.linkedin.com/v2/emailAddress?q=members&projection=(elements*(handle~))"
  )) as Record<string, unknown>;
  const elements = data.elements as Array<Record<string, unknown>> | undefined;
  const handle = elements?.[0]?.["handle~"] as Record<string, unknown> | undefined;
  return String(handle?.emailAddress ?? "");
}

export async function createPost(
  authorId: string,
  text: string,
  visibility: "PUBLIC" | "CONNECTIONS" = "PUBLIC"
): Promise<{ id: string }> {
  const body = {
    author: `urn:li:person:${authorId}`,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: { text },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": visibility,
    },
  };

  const result = (await apiPost("https://api.linkedin.com/v2/ugcPosts", body)) as Record<
    string,
    unknown
  >;
  return { id: String(result.id ?? "unknown") };
}
