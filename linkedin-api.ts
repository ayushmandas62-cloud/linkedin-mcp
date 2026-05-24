import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const REDIRECT_URI =
  process.env.LINKEDIN_REDIRECT_URI ??
  (process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/auth/callback`
    : "http://localhost:3001/auth/callback");
const TOKEN_FILE = path.join(os.homedir(), ".linkedin-mcp-token.json");
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_REDIRECTS = 3;
const OAUTH_STATE_TTL_MS = 120_000;

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
let latestOAuthState: string | null = null;
const pendingOAuthResolves = new Map<
  string,
  { resolve: (code: string | null) => void; timeout: NodeJS.Timeout }
>();

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
  latestOAuthState = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: latestOAuthState,
    scope: "openid profile email w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export function setPendingOAuthResolve(resolve: (code: string | null) => void): void {
  if (!latestOAuthState) {
    throw new Error("No OAuth state has been generated for this auth request.");
  }
  const state = latestOAuthState;
  const timeout = setTimeout(() => {
    pendingOAuthResolves.delete(state);
    resolve(null);
  }, OAUTH_STATE_TTL_MS);
  timeout.unref();
  pendingOAuthResolves.set(state, { resolve, timeout });
}

export function resolveOAuthCallback(code: string, state: string): boolean {
  const pending = pendingOAuthResolves.get(state);
  if (!pending) return false;
  pendingOAuthResolves.delete(state);
  clearTimeout(pending.timeout);
  pending.resolve(code);
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
  cachedUserInfo = null;
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

// Cached userinfo to avoid duplicate calls within the same request
let cachedUserInfo: Record<string, unknown> | null = null;

async function getUserInfo(): Promise<Record<string, unknown>> {
  if (cachedUserInfo) return cachedUserInfo;
  const data = (await apiGet("https://api.linkedin.com/v2/userinfo")) as Record<string, unknown>;
  cachedUserInfo = data;
  return data;
}

export async function getProfile(): Promise<LinkedInProfile> {
  const data = await getUserInfo();
  return {
    id: String(data.sub ?? ""),
    firstName: String(data.given_name ?? ""),
    lastName: String(data.family_name ?? ""),
    headline: String(data.headline ?? ""),
    profilePicture: data.picture as string | undefined,
  };
}

export async function getEmail(): Promise<string> {
  const data = await getUserInfo();
  return String(data.email ?? "");
}

async function restPost(
  path: string,
  body: object,
  queryParams?: Record<string, string>
): Promise<{ headers: Headers; json: unknown }> {
  if (!tokenData) throw new Error("Not authenticated with LinkedIn");
  const url = new URL(`https://api.linkedin.com${path}`);
  if (queryParams) Object.entries(queryParams).forEach(([k, v]) => url.searchParams.set(k, v));
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": "202312",
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
  const json = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;
  return { headers: response.headers, json };
}

export async function uploadImage(imageUrl: string, ownerId: string): Promise<string> {
  // Step 1: Initialize upload
  const { json: initJson } = await restPost(
    "/rest/images",
    { initializeUploadRequest: { owner: `urn:li:person:${ownerId}` } },
    { action: "initializeUpload" }
  );
  const { uploadUrl, image: imageUrn } = (initJson as { value: { uploadUrl: string; image: string } }).value;

  // Step 2: Fetch image bytes from a public URL only.
  const { bytes: imgBytes, contentType } = await fetchPublicImage(imageUrl);

  // Step 3: Upload binary to LinkedIn's presigned URL
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${tokenData!.access_token}`,
      "Content-Type": contentType,
    },
    body: imgBytes,
  });
  if (!uploadResponse.ok) {
    const text = await uploadResponse.text();
    throw new Error(`Image upload failed: ${text}`);
  }

  return imageUrn;
}

async function fetchPublicImage(
  imageUrl: string,
  redirects = 0
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  if (redirects > MAX_IMAGE_REDIRECTS) {
    throw new Error(`Image URL followed too many redirects (${MAX_IMAGE_REDIRECTS} max).`);
  }

  const url = await validatePublicHttpUrl(imageUrl);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Image URL redirected without a Location header.");
    return fetchPublicImage(new URL(location, url).toString(), redirects + 1);
  }

  if (!response.ok) throw new Error(`Could not fetch image from URL (${response.status})`);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`Image URL must return an image/* content type. Received: ${contentType || "unknown"}`);
  }

  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large. Maximum supported size is 10 MB.");
  }

  const body = response.body;
  if (!body) throw new Error("Image response had no body.");

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Image is too large. Maximum supported size is 10 MB.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { bytes: bytes.buffer, contentType };
}

async function validatePublicHttpUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Image URL is invalid.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Image URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Image URL must not include embedded credentials.");
  }

  const hostname = url.hostname;
  if (isBlockedHostname(hostname)) {
    throw new Error("Image URL must point to a public host.");
  }

  const literalIpVersion = net.isIP(hostname);
  if (literalIpVersion) {
    if (isBlockedIp(hostname)) throw new Error("Image URL must point to a public IP address.");
    return url.toString();
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new Error("Image URL resolved to a blocked or private address.");
  }

  return url.toString();
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  );
}

function isBlockedIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true;
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

export async function createImagePost(
  authorId: string,
  caption: string,
  imageUrn: string,
  visibility: "PUBLIC" | "CONNECTIONS" = "PUBLIC"
): Promise<{ id: string }> {
  const { headers } = await restPost("/rest/posts", {
    author: `urn:li:person:${authorId}`,
    commentary: caption,
    visibility,
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      media: {
        altText: caption.slice(0, 200),
        id: imageUrn,
      },
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  const id = headers.get("x-restli-id") ?? headers.get("location") ?? "unknown";
  return { id };
}

export async function deletePost(postId: string): Promise<void> {
  if (!tokenData) throw new Error("Not authenticated with LinkedIn");

  // urn:li:share:* posts are created via the REST Posts API; everything else via UGC Posts API
  let response: Response;
  if (postId.startsWith("urn:li:share:")) {
    response = await fetch(
      `https://api.linkedin.com/rest/posts/${encodeURIComponent(postId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "LinkedIn-Version": "202312",
        },
      }
    );
  } else {
    const urn = postId.startsWith("urn:") ? postId : `urn:li:ugcPost:${postId}`;
    response = await fetch(
      `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(urn)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "X-Restli-Protocol-Version": "2.0.0",
        },
      }
    );
  }

  if (response.status === 401) {
    tokenData = null;
    throw new Error("LinkedIn session expired. Please reconnect using linkedin_connect.");
  }
  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`Delete failed: ${text}`);
  }
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
