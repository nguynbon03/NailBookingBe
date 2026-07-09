import * as fs from "fs/promises";
import * as path from "path";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";
import { retrieveKnowledgeTrace } from "./chatbot-rag";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
export type RetrievedChunk = { source: string; text: string; score: number };
export type ChatbotMode = "customer" | "staff" | "admin";
export type ResponseLanguage = "en" | "vi";

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const SUPPORTED_EXTS = new Set([".md", ".txt", ".json"]);
const DEFAULT_TEXT_MODEL = "kimi-k2.6";
const DEFAULT_VISION_MODEL = "gemma3:12b";
const CORPUS_TTL_MS = 60_000;

let corpusCache: RetrievedChunk[] | null = null;
let corpusLoadedAt = 0;

function words(value: string) {
  return Array.from(
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .filter((item) => item.length > 2),
    ),
  );
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
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
    for (let start = 0; start < section.length; start += 720) {
      const text = section.slice(start, start + 960).trim();
      if (text) pieces.push({ source, text, score: 0 });
      if (start + 960 >= section.length) break;
    }
  }

  return pieces;
}

async function loadCorpus() {
  if (corpusCache && Date.now() - corpusLoadedAt < CORPUS_TTL_MS) return corpusCache;

  const files = await walk(KNOWLEDGE_DIR);
  const chunks: RetrievedChunk[] = [];
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const rel = path.relative(KNOWLEDGE_DIR, file) || path.basename(file);
    chunks.push(...splitText(rel, raw));
  }

  corpusCache = chunks;
  corpusLoadedAt = Date.now();
  return chunks;
}

function sourceBoost(query: string, source: string, text: string) {
  const q = query.toLowerCase();
  const sourceName = source.toLowerCase();
  const content = text.toLowerCase();

  let boost = 0;

  if (/(open|opening|hours|close|address|location|phone|email|contact)/.test(q) && sourceName.includes("shop-info")) {
    boost += 8;
  }
  if (/(book|booking|cancel|reschedule|refund|change|policy|complaint)/.test(q) && sourceName.includes("customer-policies")) {
    boost += 6;
  }
  if (/(photo|image|nail|bleeding|swelling|infection|lift|lifting|pain)/.test(q) && sourceName.includes("photo-guidance")) {
    boost += 6;
  }
  if (/(choose|which|difference|compare|builder|biab|acrylic|gel|ombre|extensions|natural nail|overlay)/.test(q) && sourceName.includes("service-guidance")) {
    boost += 6;
  }
  if (/(faq|first time|what should i|what do i need|how do i|book|booking|photo|price|duration)/.test(q) && sourceName.includes("customer-faq")) {
    boost += 5;
  }
  if (/(revenue|staff|leave|availability|workload|schedule|operations|unassigned|queue)/.test(q) && sourceName.includes("internal-ops")) {
    boost += 5;
  }
  if (content.includes("opening hours") && /(open|opening|hours)/.test(q)) {
    boost += 3;
  }
  if (content.includes("website booking flow") && /(book|booking)/.test(q)) {
    boost += 2;
  }
  if (sourceName.includes("soul")) {
    boost -= 1;
  }

  return boost;
}

function sourceAudience(source: string): ChatbotMode[] {
  const sourceName = source.toLowerCase();

  if (sourceName.includes("internal-ops")) {
    return ["admin", "staff"];
  }

  return ["customer", "staff", "admin"];
}

export async function retrieveKnowledge(query: string, mode: ChatbotMode, limit = 6) {
  const corpus = (await loadCorpus()).filter((item) => sourceAudience(item.source).includes(mode));
  const q = words(query);
  const scored = corpus
    .map((item) => {
      const hay = item.text.toLowerCase();
      const score =
        q.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0) +
        (hay.includes(query.toLowerCase()) ? 4 : 0) +
        sourceBoost(query, item.source, item.text);
      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: RetrievedChunk[] = [];
  const seenPerSource = new Map<string, number>();
  for (const item of scored) {
    const count = seenPerSource.get(item.source) || 0;
    if (count >= 2) continue;
    picked.push(item);
    seenPerSource.set(item.source, count + 1);
    if (picked.length >= limit) break;
  }

  return picked.length ? picked : corpus.slice(0, Math.min(limit, corpus.length));
}

function envValue(...keys: string[]) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function endpointBase() {
  return envValue("AI_CHAT_BASE_URL", "OLLAMA_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL") || "https://ollama.com/v1";
}

function textModelName() {
  return envValue("AI_CHAT_MODEL", "OLLAMA_MODEL", "OPENAI_MODEL", "OPENROUTER_MODEL") || DEFAULT_TEXT_MODEL;
}

function visionModelName() {
  return (
    envValue(
      "AI_CHAT_VISION_MODEL",
      "OLLAMA_VISION_MODEL",
      "AI_CHAT_MODEL",
      "OLLAMA_MODEL",
      "OPENAI_MODEL",
      "OPENROUTER_MODEL",
    ) || DEFAULT_VISION_MODEL
  );
}

function modelName(hasImage = false) {
  return hasImage ? visionModelName() : textModelName();
}

function apiKey() {
  return envValue("AI_CHAT_API_KEY", "OLLAMA_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY");
}

function clientHeaders(baseURL: string) {
  if (!baseURL.includes("openrouter.ai")) return undefined;
  return {
    "HTTP-Referer": envValue("PUBLIC_APP_URL", "NEXTAUTH_URL", "NEXT_PUBLIC_APP_URL") || "https://bookingnail.overpowers.agency",
    "X-Title": "Nail Lounge Assistant",
  };
}

function normalizeResponseLanguage(value?: string | null): ResponseLanguage {
  const language = String(value || "").trim().toLowerCase();
  if (["vi", "vn", "vietnamese", "tiếng việt", "tieng viet"].includes(language)) return "vi";
  return "en";
}

function defaultResponseLanguage(): ResponseLanguage {
  return normalizeResponseLanguage(envValue("SHOP_LANGUAGE", "CHATBOT_RESPONSE_LANGUAGE", "DEFAULT_LANGUAGE"));
}

function uniqueSources(chunks: RetrievedChunk[]) {
  return Array.from(new Set(chunks.map((item) => item.source))).slice(0, 8);
}

function lines(text: string, maxLines = 8) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines);
}

function compactSnapshot(text: string, maxLines = 10) {
  const picked = lines(text, maxLines);
  return picked.length ? picked.join("\n") : "No live snapshot is available right now.";
}

function modeInstructions(mode: ChatbotMode, responseLanguage: ResponseLanguage) {
  const languageRule = responseLanguage === "vi"
    ? "- Reply in natural Vietnamese only. Keep salon names, service names, prices, and booking references exact."
    : "- Reply in natural English only.";
  const shared = [
    languageRule,
    "- Sound calm, helpful, and human.",
    "- Keep answers easy to read on a phone.",
    "- Never invent facts that are missing from the live snapshot or knowledge base.",
    "- Separate confirmed facts from suggestions.",
    "- Treat uploaded images as visual reference only.",
    "- Never diagnose medical conditions or promise safety from a photo alone.",
    "- If an image suggests bleeding, severe swelling, infection, or anything medical, recommend direct salon contact first.",
  ];

  if (mode === "admin") {
    return [
      "Admin mode:",
      "- You are an internal operations copilot for the salon owner or manager.",
      "- Focus on revenue, booking pressure, staffing, leave, inbox priorities, and next actions.",
      "- Use live metrics/context first, then knowledge docs.",
      "- If a requested metric is not in the current snapshot, say so plainly.",
      ...shared,
    ].join("\n");
  }

  if (mode === "staff") {
    return [
      "Staff mode:",
      "- You are an internal assistant for schedule, assigned jobs, leave, availability, and workload.",
      "- Use the live staff snapshot first.",
      "- Do not promise policy exceptions or approvals on behalf of admin.",
      ...shared,
    ].join("\n");
  }

  return [
    "Customer mode:",
    "- You are the public-facing salon assistant.",
    "- Help with services, prices, booking steps, opening hours, contact info, prep, aftercare basics, and general suitability.",
    "- Never claim a booking is confirmed unless the live context explicitly says it is confirmed.",
    "- For complaints, refunds, cancellations, reschedules, or anything sensitive, guide the customer to contact the salon team directly.",
    ...shared,
  ].join("\n");
}

function buildKnowledgeContext(chunks: RetrievedChunk[]) {
  if (!chunks.length) return "No additional knowledge snippets were retrieved.";
  return chunks
    .slice(0, 5)
    .map((item, index) => `[${index + 1}] ${item.source}\n${item.text}`)
    .join("\n\n");
}

function buildSystemPrompt(state: ChatbotGraphStateType) {
  return [
    state.soul.trim(),
    modeInstructions(state.mode, state.responseLanguage),
    "Core response rules:",
    "- Use only the supplied knowledge, live service list, live operational snapshot, and conversation context.",
    "- Never invent prices, promotions, availability, policy exceptions, revenue totals, or booking status changes.",
    "- If you are unsure, say what is known and what should be checked with the salon team.",
    state.page ? `Current page: ${state.page}` : "",
    state.servicesText ? `Live services:\n${state.servicesText}` : "",
    state.extraContext ? `Live operational snapshot:\n${compactSnapshot(state.extraContext, 12)}` : "",
    `Knowledge context:\n${buildKnowledgeContext(state.chunks)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildFallbackAnswer(options: {
  latestUser: string;
  chunks: RetrievedChunk[];
  servicesText: string;
  mode: ChatbotMode;
  extraContext: string;
  imageDataUrl?: string | null;
  failureReason?: string;
  responseLanguage: ResponseLanguage;
}) {
  const { latestUser, chunks, servicesText, mode, extraContext, imageDataUrl, failureReason, responseLanguage } = options;
  const contextLines = compactSnapshot(extraContext, mode === "customer" ? 6 : 10);
  const knowledgeLines = chunks
    .slice(0, 3)
    .map((chunk) => `- ${chunk.text.replace(/\s+/g, " ").slice(0, 220)}…`)
    .join("\n");
  const serviceLines = lines(servicesText, 6).join("\n");

  if (responseLanguage === "vi") {
    const failureLine = failureReason ? `\n\nGhi chú hệ thống: ${failureReason}` : "";
    const imageLine = imageDataUrl
      ? "\n\nGhi chú ảnh: Tôi chỉ có thể đưa ra nhận xét hình ảnh thận trọng. Nếu có đau, viêm, chảy máu hoặc dấu hiệu y tế, hãy liên hệ trực tiếp salon trước khi làm dịch vụ."
      : "";
    if (mode === "admin") {
      return `Hiện tại tôi chưa kết nối được mô hình AI trực tiếp, nên đây là câu trả lời vận hành tốt nhất cho “${latestUser}”.\n\nDữ liệu live:\n${contextLines}${knowledgeLines ? `\n\nKiến thức liên quan:\n${knowledgeLines}` : ""}${failureLine}`;
    }
    if (mode === "staff") {
      return `Hiện tại tôi chưa kết nối được mô hình AI trực tiếp, nên đây là tóm tắt tốt nhất cho nhân viên về “${latestUser}”.\n\nDữ liệu live:\n${contextLines}${knowledgeLines ? `\n\nHướng dẫn liên quan:\n${knowledgeLines}` : ""}${failureLine}`;
    }
    return `Hiện tại tôi chưa kết nối được mô hình AI trực tiếp, nên đây là câu trả lời tốt nhất cho “${latestUser}”.\n\nThông tin tôi biết lúc này:\n${contextLines}${serviceLines ? `\n\nDịch vụ live:\n${serviceLines}` : ""}${knowledgeLines ? `\n\nHướng dẫn hữu ích:\n${knowledgeLines}` : ""}${imageLine}${failureLine}\n\nNếu cần câu trả lời chắc chắn, vui lòng dùng các nút liên hệ của salon.`;
  }

  const failureLine = failureReason ? `\n\nModel note: ${failureReason}` : "";
  const imageLine = imageDataUrl
    ? "\n\nImage note: I can only give a cautious visual opinion here. For any painful, inflamed, bleeding, or medically concerning issue, please contact the salon team directly before treatment."
    : "";

  if (mode === "admin") {
    return `I could not reach the live LLM just now, so here is the best operational answer I can give for “${latestUser}”.\n\nLive snapshot:\n${contextLines}${knowledgeLines ? `\n\nUseful knowledge:\n${knowledgeLines}` : ""}${failureLine}`;
  }

  if (mode === "staff") {
    return `I could not reach the live LLM just now, so here is the best staff snapshot for “${latestUser}”.\n\nLive snapshot:\n${contextLines}${knowledgeLines ? `\n\nUseful guidance:\n${knowledgeLines}` : ""}${failureLine}`;
  }

  return `I could not reach the live AI model just now, so here is the best answer I can give for “${latestUser}”.\n\nWhat I know right now:\n${contextLines}${serviceLines ? `\n\nLive services:\n${serviceLines}` : ""}${knowledgeLines ? `\n\nHelpful guidance:\n${knowledgeLines}` : ""}${imageLine}${failureLine}\n\nIf you need a guaranteed answer, please use the salon contact buttons below.`;
}

function normalizeAssistantContent(content: unknown) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return String(part.text || "");
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toLangChainMessage(message: ChatMessage, includeImage = false, imageDataUrl?: string | null) {
  if (message.role === "assistant") return new AIMessage(message.content);
  if (message.role === "system") return new SystemMessage(message.content);
  if (includeImage && imageDataUrl) {
    return new HumanMessage({
      content: [
        { type: "text", text: message.content },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ],
    });
  }
  return new HumanMessage(message.content);
}

const ChatbotGraphState = Annotation.Root({
  messages: Annotation<ChatMessage[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  page: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  servicesText: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  mode: Annotation<ChatbotMode>({
    reducer: (_left, right) => right,
    default: () => "customer",
  }),
  responseLanguage: Annotation<ResponseLanguage>({
    reducer: (_left, right) => right,
    default: defaultResponseLanguage,
  }),
  extraContext: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  imageDataUrl: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  latestUser: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  chunks: Annotation<RetrievedChunk[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  knowledgeEngine: Annotation<"qdrant" | "lexical">({
    reducer: (_left, right) => right,
    default: () => "lexical",
  }),
  soul: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  systemPrompt: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  answer: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
  configured: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  sources: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  failureReason: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => "",
  }),
});

type ChatbotGraphStateType = typeof ChatbotGraphState.State;

async function prepareNode(state: ChatbotGraphStateType) {
  const messages = state.messages.filter((item) => item?.content?.trim()).slice(-8);
  const latestUser = [...messages].reverse().find((item) => item.role === "user")?.content?.trim() || "";
  if (!latestUser) throw new Error("missing_user_message");

  const [{ chunks, engine }, soul] = await Promise.all([
    retrieveKnowledgeTrace(latestUser, state.mode),
    fs.readFile(path.join(KNOWLEDGE_DIR, "SOUL.md"), "utf8").catch(() => ""),
  ]);

  return {
    messages,
    latestUser,
    chunks,
    knowledgeEngine: engine,
    soul,
    sources: uniqueSources(chunks),
  };
}

async function composeNode(state: ChatbotGraphStateType) {
  return {
    systemPrompt: buildSystemPrompt(state),
  };
}

async function fallbackNode(state: ChatbotGraphStateType) {
  return {
    configured: false,
    answer: buildFallbackAnswer({
      latestUser: state.latestUser,
      chunks: state.chunks,
      servicesText: state.servicesText,
      mode: state.mode,
      extraContext: state.extraContext,
      imageDataUrl: state.imageDataUrl,
      responseLanguage: state.responseLanguage,
      failureReason: state.failureReason,
    }),
  };
}

async function llmNode(state: ChatbotGraphStateType) {
  const key = apiKey();
  if (!key) return fallbackNode(state);

  const baseURL = endpointBase();
  const headers = clientHeaders(baseURL);
  const llm = new ChatOpenAI({
    apiKey: key,
    model: modelName(Boolean(state.imageDataUrl)),
    temperature: 0.25,
    timeout: 45_000,
    maxRetries: 1,
    useResponsesApi: false,
    configuration: {
      baseURL,
      defaultHeaders: headers,
    },
  });

  const lastUserIndex = state.messages.map((item) => item.role).lastIndexOf("user");
  const promptMessages = [
    new SystemMessage(state.systemPrompt),
    ...state.messages.map((item, index) => toLangChainMessage(item, index === lastUserIndex, state.imageDataUrl)),
  ];

  try {
    const response = await llm.invoke(promptMessages);
    const answer = normalizeAssistantContent(response.content);

    return {
      configured: true,
      answer:
        answer ||
        buildFallbackAnswer({
          latestUser: state.latestUser,
          chunks: state.chunks,
          servicesText: state.servicesText,
          mode: state.mode,
          extraContext: state.extraContext,
          imageDataUrl: state.imageDataUrl,
          responseLanguage: state.responseLanguage,
          failureReason: "The model returned an empty answer.",
        }),
      failureReason: "",
    };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : "The AI provider is temporarily unavailable.";
    return {
      configured: false,
      failureReason,
      answer: buildFallbackAnswer({
        latestUser: state.latestUser,
        chunks: state.chunks,
        servicesText: state.servicesText,
        mode: state.mode,
        extraContext: state.extraContext,
        imageDataUrl: state.imageDataUrl,
        responseLanguage: state.responseLanguage,
        failureReason,
      }),
    };
  }
}

const chatbotGraph = new StateGraph(ChatbotGraphState)
  .addNode("prepare", prepareNode)
  .addNode("compose", composeNode)
  .addNode("fallback", fallbackNode)
  .addNode("llm", llmNode)
  .addEdge(START, "prepare")
  .addEdge("prepare", "compose")
  .addConditionalEdges("compose", () => (apiKey() ? "llm" : "fallback"))
  .addEdge("fallback", END)
  .addEdge("llm", END)
  .compile();

export async function generateAssistantReply(options: {
  messages: ChatMessage[];
  page?: string;
  servicesText?: string;
  mode?: ChatbotMode;
  extraContext?: string;
  imageDataUrl?: string | null;
  responseLanguage?: ResponseLanguage;
}) {
  const result = await chatbotGraph.invoke({
    messages: options.messages,
    page: String(options.page || ""),
    servicesText: String(options.servicesText || "").trim(),
    mode: options.mode || "customer",
    responseLanguage: options.responseLanguage || defaultResponseLanguage(),
    extraContext: String(options.extraContext || "").trim(),
    imageDataUrl: options.imageDataUrl || null,
  });

  return {
    configured: Boolean(result.configured),
    answer: String(result.answer || "").trim(),
    sources: result.sources || [],
    knowledgeEngine: result.knowledgeEngine || "lexical",
  };
}
