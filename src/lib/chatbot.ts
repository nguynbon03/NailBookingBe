import * as fs from "fs/promises";
import * as path from "path";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
export type RetrievedChunk = { source: string; text: string; score: number };
export type ChatbotMode = "customer" | "staff" | "admin";

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
  const base = envValue("AI_CHAT_BASE_URL", "OLLAMA_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL") || "https://api.openai.com/v1";
  return base.endsWith("/chat/completions") ? base : `${base.replace(/\/$/, "")}/chat/completions`;
}

function modelName(hasImage = false) {
  if (hasImage) {
    return envValue("AI_CHAT_VISION_MODEL", "OLLAMA_VISION_MODEL", "AI_CHAT_MODEL", "OLLAMA_MODEL", "OPENAI_MODEL", "OPENROUTER_MODEL") || "gpt-4o-mini";
  }
  return envValue("AI_CHAT_MODEL", "OLLAMA_MODEL", "OPENAI_MODEL", "OPENROUTER_MODEL") || "gpt-4o-mini";
}

function apiKey() {
  return envValue("AI_CHAT_API_KEY", "OLLAMA_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY");
}

function looksVietnamese(value: string) {
  const text = String(value || "").trim();
  if (!text) return false;
  return /[ăâêôơưđáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text)
    || /\b(hôm nay|bao nhiêu|được không|giúp|khách|đơn|doanh thu|lịch|nhân viên|xin nghỉ|đặt lịch|màu này|móng|tiệm|shop)\b/i.test(text.toLowerCase());
}

function currencyLine(value: string) {
  const normalized = String(value || "").trim();
  return normalized || "£0.00";
}

function languageFor(mode: ChatbotMode, latestUser: string) {
  if (mode === "customer") return "en";
  return looksVietnamese(latestUser) ? "vi" : "en";
}

function modeRules(mode: ChatbotMode, latestUser: string) {
  const language = languageFor(mode, latestUser);
  const shared = [
    "- Treat images as visual reference only.",
    "- Never diagnose medical conditions or promise safety from a photo alone.",
    "- If you see bleeding, severe swelling, suspected infection, major lifting, or anything medical, tell the user to contact the salon team directly and consider medical advice.",
    "- Keep the answer practical and easy to scan.",
  ];

  if (mode === "admin") {
    return [
      "Admin mode:",
      language === "vi" ? "- Trả lời bằng tiếng Việt tự nhiên." : "- Reply in the user's language.",
      "- You are an internal operations assistant for admin/manager.",
      "- Use the supplied live metrics/context first. If a live fact is missing, say it is not in the current snapshot.",
      "- Separate confirmed numbers from suggestions.",
      "- Good topics: revenue, bookings, leave, conflicts, staffing, inbox priorities, next actions.",
      ...shared,
    ].join("\n");
  }

  if (mode === "staff") {
    return [
      "Staff mode:",
      language === "vi" ? "- Trả lời bằng tiếng Việt tự nhiên." : "- Reply in the user's language.",
      "- You are an internal staff helper for schedule, leave, bookings, and today's workload.",
      "- Use the supplied live schedule/revenue context first.",
      "- Do not promise policy exceptions. For disputes or special approvals, tell staff to contact admin/manager.",
      ...shared,
    ].join("\n");
  }

  return [
    "Customer mode:",
    "- Always reply in natural English.",
    "- Be warm, concise, and mobile-friendly.",
    "- If image is attached, explain what you can visually comment on for salon suitability, but avoid medical diagnosis and recommend direct salon review for risky conditions.",
    ...shared,
  ].join("\n");
}

function buildFallbackAnswer(query: string, chunks: RetrievedChunk[], servicesText: string, mode: ChatbotMode, extraContext: string, imageDataUrl?: string | null, failureReason?: string) {
  const language = languageFor(mode, query);
  const lines = chunks.slice(0, 3).map((chunk) => `• ${chunk.text.replace(/\s+/g, " ").slice(0, 220)}…`);
  const compactContext = extraContext
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .join("\n");
  const serviceBlock = servicesText ? `\n\nLive services:\n${servicesText.split("\n").slice(0, 6).join("\n")}` : "";
  const failureNote = failureReason ? `\n\nNote: ${failureReason}` : "";

  if (mode === "customer") {
    const imageNote = imageDataUrl ? "\n\nI can only give a cautious visual opinion here. For anything painful, inflamed, bleeding, or medically concerning, please contact the salon team directly before booking." : "";
    return `I can help with salon bookings, services, prices and simple policies. The live AI provider is unavailable right now, so here is the best information I can give for “${query}”:\n\n${compactContext || lines.join("\n") || "• Please contact the salon team directly for a guaranteed answer."}${serviceBlock}${imageNote}${failureNote}\n\nIf you need a guaranteed answer, please use the salon contact buttons below.`;
  }

  if (language === "vi") {
    const imageNote = imageDataUrl ? "\n\nLưu ý: nếu ảnh có dấu hiệu viêm, sưng nặng, chảy máu hoặc nghi nhiễm trùng thì không nên kết luận chỉ qua ảnh — cần người thật kiểm tra trực tiếp." : "";
    return `Hiện AI live đang không phản hồi, nên mình trả lời bằng snapshot đang có cho câu hỏi “${query}”:\n\n${compactContext || lines.join("\n") || "Chưa có snapshot phù hợp ngay lúc này."}${serviceBlock}${imageNote}${failureNote}`;
  }

  return `The live AI provider is unavailable right now, so here is the current snapshot for “${query}”:\n\n${compactContext || lines.join("\n") || "No matching live snapshot is available right now."}${serviceBlock}${failureNote}`;
}

export async function generateAssistantReply(options: {
  messages: ChatMessage[];
  page?: string;
  servicesText?: string;
  mode?: ChatbotMode;
  extraContext?: string;
  imageDataUrl?: string | null;
}) {
  const messages = options.messages.filter((item) => item?.content?.trim()).slice(-8);
  const latestUser = [...messages].reverse().find((item) => item.role === "user")?.content?.trim() || "";
  if (!latestUser) throw new Error("missing_user_message");

  const chunks = await retrieveKnowledge(latestUser, 6);
  const servicesText = String(options.servicesText || "").trim();
  const soul = await fs.readFile(path.join(KNOWLEDGE_DIR, "SOUL.md"), "utf8").catch(() => "");
  const contextBlock = chunks.map((item, index) => `[${index + 1}] ${item.source}\n${item.text}`).join("\n\n");
  const mode = options.mode || "customer";
  const extraContext = String(options.extraContext || "").trim();
  const systemPrompt = [
    soul.trim(),
    modeRules(mode, latestUser),
    "Context rules:",
    "- Use only the supplied context, live service list, and live operational snapshot.",
    "- Never invent confirmed availability, policies, refunds, prices, promotions, revenue, or booking states.",
    options.page ? `- User is currently on page: ${options.page}` : "",
    servicesText ? `Live services:\n${servicesText}` : "",
    extraContext ? `Live operational snapshot:\n${extraContext}` : "",
    `Knowledge context:\n${contextBlock}`,
  ].filter(Boolean).join("\n\n");

  const key = apiKey();
  if (!key) {
    return {
      configured: false,
      answer: buildFallbackAnswer(latestUser, chunks, servicesText, mode, extraContext, options.imageDataUrl),
      sources: chunks.map((item) => item.source),
    };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Auth" + "orization", `${AUTH_SCHEME} ${key}`);
  if (endpoint().includes("openrouter.ai")) {
    headers.set("HTTP-Referer", "https://bookingnail.overpowers.agency");
    headers.set("X-Title", "Nail Lounge Assistant");
  }

  const lastUserIndex = messages.map((item) => item.role).lastIndexOf("user");
  const payloadMessages: any[] = [{ role: "system", content: systemPrompt }];
  messages.forEach((item, index) => {
    if (options.imageDataUrl && item.role === "user" && index === lastUserIndex) {
      payloadMessages.push({
        role: item.role,
        content: [
          { type: "text", text: item.content },
          { type: "image_url", image_url: { url: options.imageDataUrl } },
        ],
      });
      return;
    }
    payloadMessages.push({ role: item.role, content: item.content });
  });

  try {
    const res = await fetch(endpoint(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelName(Boolean(options.imageDataUrl)),
        temperature: 0.2,
        messages: payloadMessages,
      }),
      cache: "no-store",
    });

    const data = await res.json().catch(() => ({} as any));
    if (!res.ok) {
      const reason = String(data?.error?.message || data?.error || data?.message || `Upstream chat failed (${res.status})`).trim();
      return {
        configured: false,
        answer: buildFallbackAnswer(latestUser, chunks, servicesText, mode, extraContext, options.imageDataUrl, reason),
        sources: chunks.map((item) => item.source),
      };
    }

    const answer = String(data?.choices?.[0]?.message?.content || "").trim();
    return {
      configured: true,
      answer: answer || buildFallbackAnswer(latestUser, chunks, servicesText, mode, extraContext, options.imageDataUrl),
      sources: chunks.map((item) => item.source),
    };
  } catch (error) {
    return {
      configured: false,
      answer: buildFallbackAnswer(
        latestUser,
        chunks,
        servicesText,
        mode,
        extraContext,
        options.imageDataUrl,
        error instanceof Error ? error.message : "The AI provider is temporarily unavailable",
      ),
      sources: chunks.map((item) => item.source),
    };
  }
}
