import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  createPost,
  exchangeCodeForToken,
  generateAuthUrl,
  getEmail,
  getProfile,
  isAuthenticated,
  revokeToken,
  setPendingOAuthResolve,
} from "./linkedin-api.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET ?? "";

// All tools share one UI resource
const APP_RESOURCE_URI = "ui://linkedin/mcp-app.html";

function missingCredentialsResult(): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Missing LINKEDIN_CLIENT_ID or LINKEDIN_CLIENT_SECRET. Set these environment variables and restart the server.",
      },
    ],
    isError: true,
  };
}

function notConnectedResult(): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "Not connected to LinkedIn. Call the linkedin_connect tool first.",
      },
    ],
    isError: true,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "LinkedIn MCP",
    version: "1.0.0",
  });

  // ── linkedin_connect ──────────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_connect",
    {
      title: "Connect to LinkedIn",
      description:
        "Authenticate with LinkedIn via OAuth 2.0. Opens an authorization URL in the browser and waits for the callback. If already connected, returns the current profile.",
      inputSchema: {},
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      if (isAuthenticated()) {
        const profile = await getProfile();
        return {
          content: [
            {
              type: "text",
              text: `Already connected as ${profile.firstName} ${profile.lastName} (${profile.headline})`,
            },
          ],
          structuredContent: { status: "connected", profile },
        };
      }

      if (!CLIENT_ID || !CLIENT_SECRET) return missingCredentialsResult();

      const authUrl = generateAuthUrl(CLIENT_ID);

      // Wait up to 120 s for the OAuth callback
      const code = await new Promise<string | null>((resolve) => {
        setPendingOAuthResolve(resolve);
        setTimeout(() => resolve(null), 120_000);
      });

      if (!code) {
        return {
          content: [
            {
              type: "text",
              text: `Please open this URL to authenticate with LinkedIn:\n\n${authUrl}\n\nAfter authenticating, call linkedin_connect again.`,
            },
          ],
          structuredContent: { status: "pending", authUrl },
        };
      }

      await exchangeCodeForToken(code, CLIENT_ID, CLIENT_SECRET);
      const profile = await getProfile();

      return {
        content: [
          {
            type: "text",
            text: `Connected to LinkedIn as ${profile.firstName} ${profile.lastName}!`,
          },
        ],
        structuredContent: { status: "connected", profile },
      };
    }
  );

  // ── linkedin_profile ──────────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_profile",
    {
      title: "My LinkedIn Profile",
      description: "Retrieve your LinkedIn profile: name, headline, and email address.",
      inputSchema: {},
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();

      const [profile, email] = await Promise.all([getProfile(), getEmail()]);

      return {
        content: [
          {
            type: "text",
            text: [
              `Name:     ${profile.firstName} ${profile.lastName}`,
              `Headline: ${profile.headline}`,
              `Email:    ${email}`,
            ].join("\n"),
          },
        ],
        structuredContent: { ...profile, email },
      };
    }
  );

  // ── linkedin_create_post ──────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_create_post",
    {
      title: "Create LinkedIn Post",
      description: `Draft and publish a text post on LinkedIn (max 3 000 characters).

WORKFLOW — always follow these two steps:
1. Call with preview_only: true first. The UI shows a review card so the user can read the draft before it goes live. Return immediately after.
2. Wait — the UI will call this tool again with preview_only: false once the user clicks Publish, OR the user will ask you to revise the draft in chat (in which case repeat step 1 with the improved text).

Never skip step 1 and publish directly unless the user explicitly says "publish immediately".`,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(3000)
          .describe("The post content (max 3 000 characters)"),
        visibility: z
          .enum(["PUBLIC", "CONNECTIONS"])
          .default("PUBLIC")
          .describe("Who can see the post: PUBLIC or CONNECTIONS"),
        preview_only: z
          .boolean()
          .default(true)
          .describe(
            "true = show draft in UI for review without publishing (always use this first). false = publish immediately (set by the UI when user clicks Publish)."
          ),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({
      text,
      visibility = "PUBLIC",
      preview_only = true,
    }: {
      text: string;
      visibility?: "PUBLIC" | "CONNECTIONS";
      preview_only?: boolean;
    }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();

      if (preview_only) {
        return {
          content: [
            {
              type: "text",
              text: `Draft ready for review (not published yet):\n\nVisibility: ${visibility}\n\n${text}`,
            },
          ],
          structuredContent: { stage: "draft", text, visibility },
        };
      }

      const profile = await getProfile();
      const result = await createPost(profile.id, text, visibility);

      return {
        content: [
          {
            type: "text",
            text: `Post published! ID: ${result.id}\nVisibility: ${visibility}\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
          },
        ],
        structuredContent: { stage: "published", postId: result.id, text, visibility },
      };
    }
  );

  // ── linkedin_disconnect ───────────────────────────────────────────────────
  server.tool(
    "linkedin_disconnect",
    "Remove stored LinkedIn credentials and log out.",
    {},
    async (): Promise<CallToolResult> => {
      await revokeToken();
      return {
        content: [{ type: "text", text: "Disconnected from LinkedIn. Credentials removed." }],
      };
    }
  );

  // ── Shared UI resource ────────────────────────────────────────────────────
  registerAppResource(
    server,
    APP_RESOURCE_URI,
    APP_RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    }
  );

  return server;
}
