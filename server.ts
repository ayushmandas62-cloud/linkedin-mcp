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
  createImagePost,
  createPost,
  deletePost,
  generateAuthUrl,
  getEmail,
  getProfile,
  isAuthenticated,
  REDIRECT_URI,
  revokeToken,
  uploadImage,
} from "./linkedin-api.js";
import { generatePostText, generateRewrites, generateWeeklyPlan, getCronConfig } from "./cron.js";
import { addToQueue, getQueueEntry, listQueue, updateQueueEntry } from "./queue.js";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET ?? "";

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

      const authUrl = await generateAuthUrl(CLIENT_ID);

      return {
        content: [
          {
            type: "text",
            text: `Open this URL in your browser to connect LinkedIn:\n\n${authUrl}\n\nAfter you authorize, call linkedin_connect again to confirm.`,
          },
        ],
        structuredContent: { status: "pending", authUrl },
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

      // Hook strength: first line should hook the reader
      const firstLine = text.split("\n")[0] ?? "";
      const weakHookPatterns = /^(today|i am|i'm|just|so |well |here is|here's|excited to|happy to|proud to)/i;
      const hasWeakHook = weakHookPatterns.test(firstLine.trim());

      // Salesiness: promotional language reduces reach
      const salesyPatterns = /buy now|click here|limited offer|discount|promo|sign up now|don't miss/i;
      const isSalesy = salesyPatterns.test(text);

      // Repeated hashtags: detect duplicates
      const hashtagLower = hashtags.map((h) => h.toLowerCase());
      const uniqueHashtags = new Set(hashtagLower);
      const hasDuplicateHashtags = uniqueHashtags.size < hashtags.length;

      const suggestions: string[] = [];
      if (charCount < 150) suggestions.push("Too short — add more context or a story to boost engagement.");
      if (charCount > 2500) suggestions.push("Very long — consider trimming or splitting into a series.");
      if (hashtags.length === 0) suggestions.push("Add 3–5 relevant hashtags to increase reach.");
      if (hashtags.length > 8) suggestions.push("Too many hashtags (8+) looks spammy — keep it to 3–5.");
      if (paragraphs < 2) suggestions.push("Break into shorter paragraphs for easier mobile reading.");
      if (!hasQuestion && !hasCallToAction) suggestions.push("Add a question or call-to-action to encourage comments.");
      if (hasWeakHook) suggestions.push(`Weak opening hook: "${firstLine.slice(0, 60)}…" — start with a bold claim, surprising stat, or story.`);
      if (isSalesy) suggestions.push("Post reads as promotional. LinkedIn penalizes salesy content — focus on value and story.");
      if (hasDuplicateHashtags) suggestions.push("Duplicate hashtags detected — each hashtag should appear only once.");

      const penalty =
        (charCount < 150 ? 20 : 0) +
        (charCount > 2500 ? 15 : 0) +
        (hashtags.length === 0 ? 20 : hashtags.length > 8 ? 10 : 0) +
        (paragraphs < 2 ? 10 : 0) +
        (!hasQuestion && !hasCallToAction ? 10 : 0) +
        (hasWeakHook ? 10 : 0) +
        (isSalesy ? 15 : 0) +
        (hasDuplicateHashtags ? 5 : 0);
      const score = Math.max(0, 100 - penalty);

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
              `Hook strength: ${hasWeakHook ? "⚠ weak" : "✓ good"}`,
              `Salesy content: ${isSalesy ? "⚠ detected" : "✓ none"}`,
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
          hasWeakHook,
          isSalesy,
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
      const hasGeminiKey = !!process.env.GEMINI_API_KEY;

      return {
        content: [
          {
            type: "text",
            text: [
              `Daily Auto-Post: ${config.enabled ? "✅ Enabled" : "❌ Disabled"}`,
              `Schedule: ${config.cronExpr} (UTC)`,
              `Topics: ${config.topics.length ? config.topics.join(", ") : "none set"}`,
              `Visibility: ${config.visibility}`,
              `Post mode: AI generates drafts → saved to review queue → you approve before publishing`,
              `Gemini API key: ${hasGeminiKey ? "✅ set" : "❌ missing (free at aistudio.google.com)"}`,
              `LinkedIn auth: ${isAuthenticated() ? "✅ connected" : "❌ not connected"}`,
              !config.enabled
                ? "\nTo enable: set DAILY_POST_ENABLED=true in Railway Variables"
                : "",
              !hasGeminiKey
                ? "To generate posts: set GEMINI_API_KEY in Railway Variables"
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        structuredContent: { ...config, hasGeminiKey, authenticated: isAuthenticated() },
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
        "Use Gemini AI to generate a LinkedIn post on a given topic, then show a draft review screen before publishing. Great for testing the daily post feature or posting on demand.",
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

  // ── linkedin_post_image ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_post_image",
    {
      title: "Post Image to LinkedIn",
      description: `Post an image with a caption to LinkedIn.

WORKFLOW:
1. Before calling this tool, suggest 3 caption options to the user in chat so they can pick one or ask for edits.
2. Call with preview_only: true to show the draft review card.
3. Wait — UI will call again with preview_only: false when user clicks Publish.`,
      inputSchema: {
        image_url: z
          .string()
          .url()
          .describe("Publicly accessible URL of the image (Google Photos share link, Imgur, etc.)"),
        caption: z
          .string()
          .min(1)
          .max(3000)
          .describe("Caption text for the post"),
        visibility: z
          .enum(["PUBLIC", "CONNECTIONS"])
          .default("PUBLIC")
          .describe("Who can see the post"),
        preview_only: z
          .boolean()
          .default(true)
          .describe("true = show draft for review. false = publish (set by UI when user clicks Publish)."),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({
      image_url,
      caption,
      visibility = "PUBLIC",
      preview_only = true,
    }: {
      image_url: string;
      caption: string;
      visibility?: "PUBLIC" | "CONNECTIONS";
      preview_only?: boolean;
    }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();

      if (preview_only) {
        return {
          content: [
            {
              type: "text",
              text: `Image post draft ready for review.\n\nCaption: ${caption}\nVisibility: ${visibility}\nImage: ${image_url}`,
            },
          ],
          structuredContent: { stage: "draft", imageUrl: image_url, text: caption, visibility },
        };
      }

      const profile = await getProfile();
      const imageUrn = await uploadImage(image_url, profile.id);
      const result = await createImagePost(profile.id, caption, imageUrn, visibility);

      return {
        content: [
          {
            type: "text",
            text: `Image post published! ID: ${result.id}\n\n${caption.slice(0, 200)}${caption.length > 200 ? "…" : ""}`,
          },
        ],
        structuredContent: { stage: "published", postId: result.id, imageUrl: image_url, text: caption, visibility },
      };
    }
  );

  // ── linkedin_delete_post ──────────────────────────────────────────────────
  server.tool(
    "linkedin_delete_post",
    "Delete one of your LinkedIn posts by its ID. Only call this after the user has explicitly confirmed deletion.",
    {
      post_id: z.string().min(1).describe("The post ID returned when the post was created"),
      confirm: z
        .literal(true)
        .describe("Must be true. Set only after the user explicitly confirms deletion."),
    },
    async ({ post_id }: { post_id: string; confirm: true }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();
      await deletePost(post_id);
      return {
        content: [{ type: "text", text: `Post ${post_id} deleted successfully.` }],
      };
    }
  );

  // ── linkedin_list_queue ───────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_list_queue",
    {
      title: "Review Post Queue",
      description:
        "Show all AI-generated posts waiting for your approval before publishing. Use linkedin_approve_post to publish one or linkedin_reject_post to discard.",
      inputSchema: {},
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      const pending = await listQueue("pending");

      if (pending.length === 0) {
        return {
          content: [{ type: "text", text: "No posts waiting for review. Queue is empty." }],
          structuredContent: { queue: [], count: 0 },
        };
      }

      const summary = pending
        .map((e, i) => `${i + 1}. [${e.id.slice(0, 8)}] ${e.topic ?? "no topic"} — ${e.text.slice(0, 80)}…`)
        .join("\n");

      return {
        content: [
          {
            type: "text",
            text: `${pending.length} post(s) waiting for review:\n\n${summary}\n\nUse the UI to approve or reject each post.`,
          },
        ],
        structuredContent: { queue: pending, count: pending.length },
      };
    }
  );

  // ── linkedin_approve_post ─────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_approve_post",
    {
      title: "Approve & Publish Queued Post",
      description:
        "Publish a queued post. Always show the post content to the user for confirmation before calling this. Pass edited_text if the user wants to make changes first.",
      inputSchema: {
        queue_id: z.string().describe("The queue entry ID (from linkedin_list_queue)"),
        edited_text: z
          .string()
          .optional()
          .describe("Optional: override the original text with user-edited version"),
        confirm: z
          .literal(true)
          .describe("Must be true — set only after user has seen and approved the post content."),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({
      queue_id,
      edited_text,
      confirm: _confirm,
    }: {
      queue_id: string;
      edited_text?: string;
      confirm: true;
    }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();

      const entry = await getQueueEntry(queue_id);
      if (!entry) {
        return {
          content: [{ type: "text", text: `Queue entry ${queue_id} not found.` }],
          isError: true,
        };
      }
      if (entry.status !== "pending") {
        return {
          content: [{ type: "text", text: `Entry ${queue_id} is already ${entry.status}.` }],
          isError: true,
        };
      }

      const text = edited_text ?? entry.text;
      const profile = await getProfile();
      const result = await createPost(profile.id, text, entry.visibility);

      await updateQueueEntry(queue_id, {
        status: "published",
        publishedAt: new Date().toISOString(),
        postId: result.id,
        text,
      });

      return {
        content: [
          {
            type: "text",
            text: `Post published! ID: ${result.id}\n\n${text.slice(0, 200)}${text.length > 200 ? "…" : ""}`,
          },
        ],
        structuredContent: { stage: "published", postId: result.id, text, visibility: entry.visibility },
      };
    }
  );

  // ── linkedin_reject_post ──────────────────────────────────────────────────
  server.tool(
    "linkedin_reject_post",
    "Discard a queued post without publishing it.",
    {
      queue_id: z.string().describe("The queue entry ID (from linkedin_list_queue)"),
    },
    async ({ queue_id }: { queue_id: string }): Promise<CallToolResult> => {
      const entry = await updateQueueEntry(queue_id, { status: "rejected" });
      if (!entry) {
        return {
          content: [{ type: "text", text: `Queue entry ${queue_id} not found.` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Post discarded: "${entry.text.slice(0, 80)}…"`,
          },
        ],
        structuredContent: { rejected: true, queue_id },
      };
    }
  );

  // ── linkedin_weekly_plan ──────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_weekly_plan",
    {
      title: "Generate Weekly Content Plan",
      description:
        "Use Gemini AI to generate 7 LinkedIn posts — one for each day of the week. Topics rotate through the provided list. Shows all drafts for review before any are published.",
      inputSchema: {
        topics: z
          .string()
          .optional()
          .describe("Comma-separated topics (e.g. 'AI trends, productivity'). Falls back to DAILY_POST_TOPICS env var."),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({ topics }: { topics?: string }): Promise<CallToolResult> => {
      if (!isAuthenticated()) return notConnectedResult();
      if (!process.env.GEMINI_API_KEY) {
        return { content: [{ type: "text", text: "GEMINI_API_KEY is not set." }], isError: true };
      }

      const topicList = topics
        ? topics.split(",").map((t) => t.trim()).filter(Boolean)
        : getCronConfig().topics;

      if (topicList.length === 0) {
        return {
          content: [{ type: "text", text: "No topics provided. Pass topics as argument or set DAILY_POST_TOPICS in Railway." }],
          isError: true,
        };
      }

      const posts = await generateWeeklyPlan(topicList);

      // Add all 7 posts to the queue as pending
      for (const post of posts) {
        await addToQueue({
          source: "weekly-plan",
          topic: post.topic,
          text: post.text,
          visibility: "PUBLIC",
          status: "pending",
        });
      }

      return {
        content: [{ type: "text", text: `Generated ${posts.length} posts for the week. All added to queue for review. Use linkedin_list_queue to approve.` }],
        structuredContent: { weeklyPlan: posts },
      };
    }
  );

  // ── linkedin_rewrite_post ─────────────────────────────────────────────────
  registerAppTool(
    server,
    "linkedin_rewrite_post",
    {
      title: "Rewrite Post in 3 Styles",
      description:
        "Take any LinkedIn post draft and rewrite it in 3 styles: Professional, Storytelling, and Thought Leader. Pick the one that fits best.",
      inputSchema: {
        text: z.string().min(1).describe("The post text to rewrite"),
      },
      _meta: { ui: { resourceUri: APP_RESOURCE_URI } },
    },
    async ({ text }: { text: string }): Promise<CallToolResult> => {
      if (!process.env.GEMINI_API_KEY) {
        return { content: [{ type: "text", text: "GEMINI_API_KEY is not set." }], isError: true };
      }

      const rewrites = await generateRewrites(text);

      return {
        content: [{ type: "text", text: "Here are 3 rewrites. Pick one from the UI or ask Claude to mix elements." }],
        structuredContent: { original: text, ...rewrites },
      };
    }
  );

  // ── linkedin_doctor ───────────────────────────────────────────────────────
  server.tool(
    "linkedin_doctor",
    "Run a setup health check: verify env vars, LinkedIn auth, Gemini key, redirect URI, and build assets. Call this first if anything seems misconfigured.",
    {},
    async (): Promise<CallToolResult> => {
      const hasClientId = !!process.env.LINKEDIN_CLIENT_ID;
      const hasClientSecret = !!process.env.LINKEDIN_CLIENT_SECRET;
      const hasGeminiKey = !!process.env.GEMINI_API_KEY;
      const authenticated = isAuthenticated();

      let buildAssetsOk = false;
      try {
        await fs.access(path.join(DIST_DIR, "mcp-app.html"));
        buildAssetsOk = true;
      } catch {}

      const checks = [
        { label: "LINKEDIN_CLIENT_ID set", ok: hasClientId, fix: "Set LINKEDIN_CLIENT_ID env var" },
        { label: "LINKEDIN_CLIENT_SECRET set", ok: hasClientSecret, fix: "Set LINKEDIN_CLIENT_SECRET env var" },
        { label: "LinkedIn authenticated", ok: authenticated, fix: "Call linkedin_connect" },
        { label: "GEMINI_API_KEY set", ok: hasGeminiKey, fix: "Optional: set GEMINI_API_KEY for AI generation (free at aistudio.google.com)" },
        { label: "Build assets present", ok: buildAssetsOk, fix: "Run: npm run build" },
      ];

      const allOk = checks.every((c) => c.ok || c.label.startsWith("GEMINI"));
      const lines = checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.label}${!c.ok ? `\n   → ${c.fix}` : ""}`);

      lines.push("");
      lines.push(`Redirect URI: ${REDIRECT_URI}`);
      lines.push("(This must match exactly what you set in your LinkedIn App → Auth → Redirect URLs)");

      return {
        content: [
          {
            type: "text",
            text: [
              `LinkedIn MCP — Setup Doctor ${allOk ? "✅ All good!" : "⚠ Issues found"}`,
              "",
              ...lines,
            ].join("\n"),
          },
        ],
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
