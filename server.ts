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
import { generatePostText, getCronConfig } from "./cron.js";

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

  // ── linkedin_analyze_profile ──────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_analyze_profile",
    {
      title: "Analyze LinkedIn Profile",
      description:
        "Fetch and score your LinkedIn profile completeness. Returns structured data so Claude can provide specific improvement recommendations for your headline, photo, and other fields.",
      inputSchema: {},
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();

      const [profile, email] = await Promise.all([getProfile(), getEmail()]);

      const fields = {
        name: !!(profile.firstName && profile.lastName),
        headline: !!profile.headline,
        photo: !!profile.profilePicture,
        email: !!email,
      };

      const score = Math.round(
        (Object.values(fields).filter(Boolean).length / Object.keys(fields).length) * 100
      );
      const missing = Object.entries(fields)
        .filter(([, v]) => !v)
        .map(([k]) => k);

      return {
        content: [
          {
            type: "text",
            text: [
              `Profile Completeness: ${score}%`,
              `Name: ${profile.firstName} ${profile.lastName}`,
              `Headline: ${profile.headline || "missing"}`,
              `Photo: ${profile.profilePicture ? "set" : "missing"}`,
              `Email: ${email || "missing"}`,
              missing.length ? `\nMissing: ${missing.join(", ")}` : "\nAll key fields complete!",
            ].join("\n"),
          },
        ],
        structuredContent: { profile, email, fields, score, missing },
      };
    }
  );

  // ── linkedin_post_advisor ─────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_post_advisor",
    {
      title: "LinkedIn Post Advisor",
      description:
        "Analyze a post draft before publishing. Returns character count, hashtag count, readability metrics, and engagement suggestions. Call this before linkedin_create_post to optimize the text.",
      inputSchema: {
        text: z.string().min(1).describe("The post draft to analyze"),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({ text }: { text: string }): Promise<CallToolResult> => {
      const charCount = text.length;
      const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
      const paragraphs = text.split(/\n\s*\n/).filter(Boolean).length;
      const hashtags = (text.match(/#\w+/g) ?? []);
      const mentions = (text.match(/@\w+/g) ?? []);
      const hasQuestion = text.includes("?");
      const hasCallToAction = /comment|share|thoughts|think|let me know|drop|agree|disagree/i.test(text);
      const readTimeSec = Math.ceil(wordCount / 4);

      const suggestions: string[] = [];
      if (charCount < 150) suggestions.push("Too short — add more context or a story to boost engagement.");
      if (charCount > 2500) suggestions.push("Very long — consider trimming or splitting into a series.");
      if (hashtags.length === 0) suggestions.push("Add 3–5 relevant hashtags to increase reach.");
      if (hashtags.length > 8) suggestions.push("Too many hashtags (8+) looks spammy — keep it to 3–5.");
      if (paragraphs < 2) suggestions.push("Break into shorter paragraphs for easier mobile reading.");
      if (!hasQuestion && !hasCallToAction) suggestions.push("Add a question or call-to-action to encourage comments.");

      const score = Math.max(
        0,
        100 -
          (charCount < 150 ? 20 : 0) -
          (charCount > 2500 ? 15 : 0) -
          (hashtags.length === 0 ? 20 : hashtags.length > 8 ? 10 : 0) -
          (paragraphs < 2 ? 15 : 0) -
          (!hasQuestion && !hasCallToAction ? 15 : 0)
      );

      return {
        content: [
          {
            type: "text",
            text: [
              `Post Advisor Score: ${score}/100`,
              `Characters: ${charCount}/3000`,
              `Words: ${wordCount} (~${readTimeSec}s read)`,
              `Hashtags: ${hashtags.length} ${hashtags.length ? `(${hashtags.join(" ")})` : ""}`,
              `Mentions: ${mentions.length}`,
              `Paragraphs: ${paragraphs}`,
              `Has CTA/question: ${hasQuestion || hasCallToAction ? "yes" : "no"}`,
              suggestions.length
                ? `\nSuggestions:\n${suggestions.map((s) => `• ${s}`).join("\n")}`
                : "\n✅ Post looks well-optimized!",
            ].join("\n"),
          },
        ],
        structuredContent: {
          score,
          charCount,
          wordCount,
          readTimeSec,
          paragraphs,
          hashtags,
          mentions,
          hasQuestion,
          hasCallToAction,
          suggestions,
        },
      };
    }
  );

  // ── linkedin_schedule_status ──────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_schedule_status",
    {
      title: "Daily Post Schedule",
      description:
        "Show the current daily auto-posting schedule: whether it's enabled, when it runs, and what topics it rotates through.",
      inputSchema: {},
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      const config = getCronConfig();
      const hasAnthropicKey = !!process.env.GEMINI_API_KEY;

      return {
        content: [
          {
            type: "text",
            text: [
              `Daily Auto-Post: ${config.enabled ? "✅ Enabled" : "❌ Disabled"}`,
              `Schedule: ${config.cronExpr} (UTC)`,
              `Topics: ${config.topics.length ? config.topics.join(", ") : "none set"}`,
              `Visibility: ${config.visibility}`,
              `Gemini API key: ${hasAnthropicKey ? "✅ set" : "❌ missing (free at aistudio.google.com)"}`,
              `LinkedIn auth: ${isAuthenticated() ? "✅ connected" : "❌ not connected"}`,
              !config.enabled
                ? "\nTo enable: set DAILY_POST_ENABLED=true in Railway Variables"
                : "",
              !hasAnthropicKey
                ? "To generate posts: set GEMINI_API_KEY in Railway Variables"
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        structuredContent: { ...config, hasAnthropicKey, authenticated: isAuthenticated() },
      };
    }
  );

  // ── linkedin_post_now ─────────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_post_now",
    {
      title: "Generate & Post Now",
      description:
        "Use Claude AI to generate a LinkedIn post on a given topic, then show a draft review screen before publishing. Great for testing the daily post feature or posting on demand.",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .describe("Topic or theme for the post (e.g. 'AI in healthcare', 'remote work tips')"),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({ topic }: { topic: string }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();
      if (!process.env.GEMINI_API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: "GEMINI_API_KEY is not set. Add it in Railway Variables to enable AI post generation.",
            },
          ],
          isError: true,
        };
      }

      const text = await generatePostText(topic);

      return {
        content: [
          {
            type: "text",
            text: `Generated post about "${topic}" — showing draft for review before publishing.`,
          },
        ],
        structuredContent: { stage: "draft", text, visibility: "PUBLIC", generatedTopic: topic },
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
