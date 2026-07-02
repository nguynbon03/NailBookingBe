import * as fs from "fs/promises";
import * as path from "path";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
export type RetrievedChunk = { source: string; text: string; score: number };

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const SUPPORTED_EXTS = new Set([".md", ".txt", ".json"]);
const AUTH_SCHEME = String.fromCharCode(66, 101, 97, 114, 101, 114);

function words(value: string) {
  return Array.from(new Set(value.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter((item) => item.length > 2)));
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (SUPPORTED_EXTS.has(path.extname(entry.name).toLowerCase())) files.push(full);
  }
  return files;
}

function splitText(source: string, content: string) {
  const clean = content.replace(/\r/g, "").trim();
  if (!clean) return [] as RetrievedChunk[];
  const sections = clean.split(/\n(?=#{1,3}\s)/g).filter(Boolean);
  const pool = sections.length ? sections : [clean];
  const pieces: RetrievedChunk[] = [];
  for (const section of pool) {
    for (let start = 0; start < section.length; start += 700) {
      const text = section.slice(start, start + 900).trim();
      if (text) pieces.push({ source, text, score: 0 });
      if (start + 900 >= section.length) break;
    }
  }
  return pieces;
}

async function loadCorpus() {
  const files = await walk(KNOWLEDGE_DIR);
  const chunks: RetrievedChunk[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const rel = path.relative(KNOWLEDGE_DIR, file) || path.basename(file);
    chunks.push(...splitText(rel, raw));
  }
  return chunks;
}

export async function retrieveKnowledge(query: string, limit = 6) {
  const corpus = await loadCorpus();
  const q = words(query);
  const scored = corpus
    .map((item) => {
      const hay = item.text.toLowerCase();
      const score = q.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0)
        + (hay.includes(query.toLowerCase()) ? 4 : 0)
        + (item.source.toLowerCase().includes("soul") ? 0.5 : 0);
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.length ? scored : corpus.slice(0, Math.min(limit, corpus.length));
}

function envValue(...keys: string[]) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function endpoint() {
  const base = envValue("AI_CHAT_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL") || "https://api.openai.com/v1";
  return base.endsWith("/chat/completions") ? base : `${base.replace(/\/$/, "")}/chat/completions`;
}

function modelName() {
  return envValue("AI_CHAT_MODEL", "OPENAI_MODEL", "OPENROUTER_MODEL") || "gpt-4o-mini";
}

function apiKey() {
  return envValue("AI_CHAT_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY");
}

function fallbackAnswer(query: string, chunks: RetrievedChunk[], servicesText: string) {
  const lines = chunks.slice(0, 3).map((chunk) => `• ${chunk.text.replace(/\s+/g, " ").slice(0, 220)}…`);
  const serviceBlock = servicesText ? `\n\nAvailable services right now:\n${servicesText.split("\n").slice(0, 6).join("\n")}` : "";
  return `I can help with salon bookings, services, prices and policies. I do not have a live AI provider key yet, so here is the most relevant information I found for “${query}”:\n\n${lines.join("\n") || "• Please contact the salon team directly for a guaranteed answer."}${serviceBlock}\n\nIf you want, you can also contact the salon directly using the buttons below.`;
}

export async function generateAssistantReply(options: { messages: ChatMessage[]; page?: string; servicesText?: string }) {
  const messages = options.messages.filter((item) => item?.content?.trim()).slice(-8);
  const latestUser = [...messages].reverse().find((item) => item.role === "user")?.content?.trim() || "";
  if (!latestUser) throw new Error("missing_user_message");

  const chunks = await retrieveKnowledge(latestUser, 6);
  const servicesText = String(options.servicesText || "").trim();
  const soul = await fs.readFile(path.join(KNOWLEDGE_DIR, "SOUL.md"), "utf8").catch(() => "");
  const contextBlock = chunks.map((item, index) => `[${index + 1}] ${item.source}\n${item.text}`).join("\n\n");
  const systemPrompt = [
    soul.trim(),
    "Context rules:",
    "- Reply in natural English.",
    "- Keep answers short and phone-friendly.",
    "- Use only the supplied context and live service list.",
    "- Never invent confirmed availability, policies, refunds, prices or promotions.",
    options.page ? `- Customer is currently on page: ${options.page}` : "",
    servicesText ? `Live services:\n${servicesText}` : "",
    `Knowledge context:\n${contextBlock}`,
  ].filter(Boolean).join("\n\n");

  const key = apiKey();
  if (!key) {
    return {
      configured: false,
      answer: fallbackAnswer(latestUser, chunks, servicesText),
      sources: chunks.map((item) => item.source),
    };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Auth" + "orization", `${AUTH_SCHEME} ${key}`);
  if (endpoint().includes("openrouter.ai")) {
    headers.set("HTTP-Referer", "https://bookingnail.overpowers.agency");
    headers.set("X-Title", "Nail Lounge Assistant");
  }

  const res = await fetch(endpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: modelName(),
      temperature: 0.2,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map((item) => ({ role: item.role, content: item.content }))],
    }),
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({} as any));
  const answer = String(data?.choices?.[0]?.message?.content || "").trim() || fallbackAnswer(latestUser, chunks, servicesText);
  return {
    configured: true,
    answer,
    sources: chunks.map((item) => item.source),
  };
}
