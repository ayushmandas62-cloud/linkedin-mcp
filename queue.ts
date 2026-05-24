import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type QueueStatus = "pending" | "published" | "rejected";

export interface QueueEntry {
  id: string;
  createdAt: string;
  source: "cron" | "weekly-plan" | "manual";
  topic?: string;
  text: string;
  imageUrl?: string;
  visibility: "PUBLIC" | "CONNECTIONS";
  status: QueueStatus;
  publishedAt?: string;
  postId?: string;
}

const QUEUE_FILE = path.join(os.homedir(), ".linkedin-mcp-queue.json");

async function readQueue(): Promise<QueueEntry[]> {
  try {
    return JSON.parse(await fs.readFile(QUEUE_FILE, "utf-8")) as QueueEntry[];
  } catch {
    return [];
  }
}

async function writeQueue(entries: QueueEntry[]): Promise<void> {
  await fs.writeFile(QUEUE_FILE, JSON.stringify(entries, null, 2), "utf-8");
}

export async function addToQueue(
  entry: Omit<QueueEntry, "id" | "createdAt">
): Promise<QueueEntry> {
  const entries = await readQueue();
  const newEntry: QueueEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry,
  };
  entries.push(newEntry);
  await writeQueue(entries);
  return newEntry;
}

export async function listQueue(status?: QueueStatus): Promise<QueueEntry[]> {
  const entries = await readQueue();
  if (!status) return entries;
  return entries.filter((e) => e.status === status);
}

export async function getQueueEntry(id: string): Promise<QueueEntry | null> {
  const entries = await readQueue();
  return entries.find((e) => e.id === id) ?? null;
}

export async function updateQueueEntry(
  id: string,
  patch: Partial<Omit<QueueEntry, "id" | "createdAt">>
): Promise<QueueEntry | null> {
  const entries = await readQueue();
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return null;
  entries[idx] = { ...entries[idx], ...patch };
  await writeQueue(entries);
  return entries[idx];
}
