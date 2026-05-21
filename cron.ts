import Anthropic from "@anthropic-ai/sdk";
import cron from "node-cron";
import { createPost, getProfile, initializeToken, isAuthenticated } from "./linkedin-api.js";

export interface CronConfig {
  enabled: boolean;
  cronExpr: string;
  topics: string[];
  visibility: "PUBLIC" | "CONNECTIONS";
}

export function getCronConfig(): CronConfig {
  return {
    enabled: process.env.DAILY_POST_ENABLED === "true",
    cronExpr: process.env.DAILY_POST_CRON ?? "0 9 * * *",
    topics: (process.env.DAILY_POST_TOPICS ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    visibility: (process.env.DAILY_POST_VISIBILITY as "PUBLIC" | "CONNECTIONS") ?? "PUBLIC",
  };
}

export async function generatePostText(topic: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in environment variables.");

  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Write a LinkedIn post about: ${topic}

Requirements:
- Professional, authentic, first-person voice
- 150–300 words
- 3–5 relevant hashtags at the end
- End with a question or call-to-action to encourage comments
- No markdown formatting, plain text only

Return ONLY the post text, nothing else.`,
      },
    ],
  });

  const block = msg.content[0];
  if (block.type !== "text") throw new Error("Unexpected Claude API response");
  return block.text.trim();
}

export function startCronJob(): void {
  const config = getCronConfig();

  if (!config.enabled) {
    console.log("[cron] Daily posting disabled — set DAILY_POST_ENABLED=true to enable");
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[cron] DAILY_POST_ENABLED=true but ANTHROPIC_API_KEY not set — skipping");
    return;
  }
  if (config.topics.length === 0) {
    console.warn("[cron] DAILY_POST_TOPICS is empty — skipping");
    return;
  }
  if (!cron.validate(config.cronExpr)) {
    console.warn(`[cron] Invalid cron expression: ${config.cronExpr} — skipping`);
    return;
  }

  cron.schedule(
    config.cronExpr,
    async () => {
      console.log("[cron] Starting daily LinkedIn post...");
      try {
        await initializeToken();
        if (!isAuthenticated()) {
          console.warn("[cron] Not authenticated — call linkedin_connect to re-authenticate");
          return;
        }

        const topic = config.topics[Math.floor(Math.random() * config.topics.length)];
        console.log(`[cron] Generating post on topic: "${topic}"`);

        const text = await generatePostText(topic);
        const profile = await getProfile();
        const result = await createPost(profile.id, text, config.visibility);

        console.log(`[cron] ✅ Posted! ID: ${result.id} | Topic: ${topic}`);
      } catch (err) {
        console.error("[cron] ❌ Failed:", err instanceof Error ? err.message : String(err));
      }
    },
    { timezone: "UTC" }
  );

  console.log(`[cron] Daily post scheduled — expr: "${config.cronExpr}" UTC`);
  console.log(`[cron] Topics pool: ${config.topics.join(" | ")}`);
}
