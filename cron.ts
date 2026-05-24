import { GoogleGenerativeAI } from "@google/generative-ai";
import cron from "node-cron";
import { createPost, getProfile, initializeToken, isAuthenticated } from "./linkedin-api.js";
import { addToQueue } from "./queue.js";

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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Get a free key at aistudio.google.com/app/apikey");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `Write a LinkedIn post about: ${topic}

Requirements:
- Professional, authentic, first-person voice
- 150–300 words
- 3–5 relevant hashtags at the end
- End with a question or call-to-action to encourage comments
- No markdown formatting, plain text only

Return ONLY the post text, nothing else.`;

  const result = await model.generateContent(prompt);
  return result.response.text().trim();
}

// Sequential to avoid Gemini rate limits on free-tier keys
export async function generateWeeklyPlan(
  topics: string[]
): Promise<{ day: number; dayName: string; topic: string; text: string }[]> {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const results: { day: number; dayName: string; topic: string; text: string }[] = [];
  for (let i = 0; i < days.length; i++) {
    const topic = topics[i % topics.length];
    const text = await generatePostText(topic);
    results.push({ day: i + 1, dayName: days[i], topic, text });
  }
  return results;
}

export async function generateRewrites(
  text: string
): Promise<{ professional: string; storytelling: string; thoughtLeader: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Get a free key at aistudio.google.com/app/apikey");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `Rewrite this LinkedIn post in 3 different styles. Keep 150–300 words and add 3–5 hashtags to each.

Original:
${text}

Return EXACTLY in this format, no extra text:
===PROFESSIONAL===
[formal, authoritative, insights-focused rewrite]
===STORYTELLING===
[personal narrative, emotional, first-person story rewrite]
===THOUGHT_LEADER===
[bold opinion, contrarian take, sparks debate rewrite]`;

  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim();

  const extract = (marker: string, next: string) => {
    const start = raw.indexOf(`===${marker}===`) + `===${marker}===`.length;
    const end = next ? raw.indexOf(`===${next}===`) : raw.length;
    return raw.slice(start, end).trim();
  };

  return {
    professional: extract("PROFESSIONAL", "STORYTELLING"),
    storytelling: extract("STORYTELLING", "THOUGHT_LEADER"),
    thoughtLeader: extract("THOUGHT_LEADER", ""),
  };
}

export function startCronJob(): void {
  const config = getCronConfig();

  if (!config.enabled) {
    console.log("[cron] Daily posting disabled — set DAILY_POST_ENABLED=true to enable");
    return;
  }
  if (!process.env.GEMINI_API_KEY) {
    console.warn("[cron] DAILY_POST_ENABLED=true but GEMINI_API_KEY not set — skipping");
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

        // Always queue for human review — never auto-publish AI content
        const entry = await addToQueue({
          source: "cron",
          topic,
          text,
          visibility: config.visibility,
          status: "pending",
        });
        console.log(`[cron] Post queued for review: ${entry.id} | Topic: ${topic}`);
        console.log("[cron] Review and publish via linkedin_list_queue");
      } catch (err) {
        console.error("[cron] Failed:", err instanceof Error ? err.message : String(err));
      }
    },
    { timezone: "UTC" }
  );

  console.log(`[cron] Daily post scheduled — expr: "${config.cronExpr}" UTC`);
  console.log(`[cron] Topics pool: ${config.topics.join(" | ")}`);
  console.log("[cron] Posts queue for human review — use linkedin_list_queue to approve");
}
