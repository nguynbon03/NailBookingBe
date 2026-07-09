import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";

export type KnowledgeMode = "customer" | "staff" | "admin";
export type RetrievedChunk = { source: string; text: string; score: number };

type KnowledgeChunk = RetrievedChunk & {
  id: string;
  audiences: KnowledgeMode[];
  vector: number[];
};

type QdrantPoint = {
  id: string | number;
  score?: number;
  payload?: {
    source?: string;
    text?: string;
    audiences?: KnowledgeMode[];
    app?: string;
  };
};

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");
const SUPPORTED_EXTS = new Set([".md", ".txt", ".json"]);
const CORPUS_TTL_MS = 60_000;
const QDRANT_SYNC_TTL_MS = 5 * 60_000;
const HASH_VECTOR_SIZE = numericEnv(["CHATBOT_HASH_VECTOR_DIM", "QDRANT_HASH_VECTOR_DIM"], 384);
const DEFAULT_TOP_K = numericEnv(["CHATBOT_TOP_K", "QDRANT_TOP_K"], 8);
const DEFAULT_CHUNK_SIZE = numericEnv(["CHATBOT_CHUNK_SIZE", "QDRANT_CHUNK_SIZE"], 720);
const DEFAULT_CHUNK_OVERLAP = numericEnv(["CHATBOT_CHUNK_OVERLAP", "QDRANT_CHUNK_OVERLAP"], 160);
const QDRANT_COLLECTION = envValue("QDRANT_COLLECTION", "CHATBOT_QDRANT_COLLECTION") || "nailbooking-knowledge-v2";
const QDRANT_APP_TAG = envValue("QDRANT_APP_TAG", "CHATBOT_QDRANT_APP_TAG") || `nailbooking-chatbot-${envValue("APP_EDITION") || "pro"}`;

let corpusCache: KnowledgeChunk[] | null = null;
let corpusLoadedAt = 0;
let lastQdrantSignature = "";
let lastQdrantSyncAt = 0;
let embeddingsUnavailableUntil = 0;

function envValue(...keys: string[]) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function numericEnv(keys: string[], fallback: number) {
  for (const key of keys) {
    const value = Number(String(process.env[key] || "").trim());
    if (Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return fallback;
}

function flagEnv(keys: string[], fallback = false) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(value)) return true;
    if (["0", "false", "no", "off"].includes(value)) return false;
  }
  return fallback;
}

function qdrantUrl() {
  return envValue("QDRANT_URL", "CHATBOT_QDRANT_URL").replace(/\/$/, "");
}

function qdrantApiKey() {
  return envValue("QDRANT_API_KEY", "CHATBOT_QDRANT_API_KEY");
}

function qdrantEnabled() {
  return Boolean(qdrantUrl());
}

function embeddingBaseUrl() {
  return (envValue("CHATBOT_EMBEDDING_BASE_URL", "OPENAI_EMBEDDING_BASE_URL", "AI_CHAT_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, "");
}

function embeddingApiKey() {
  return envValue("CHATBOT_EMBEDDING_API_KEY", "OPENAI_EMBEDDING_API_KEY", "AI_CHAT_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY");
}

function embeddingModel() {
  return envValue("CHATBOT_EMBEDDING_MODEL", "OPENAI_EMBEDDING_MODEL") || "text-embedding-3-small";
}

function realEmbeddingsEnabled() {
  return Boolean(embeddingApiKey() && embeddingModel()) && Date.now() > embeddingsUnavailableUntil;
}

function expectedVectorSize() {
  return realEmbeddingsEnabled() ? numericEnv(["CHATBOT_VECTOR_DIM", "QDRANT_VECTOR_DIM"], 1536) : HASH_VECTOR_SIZE;
}

function stableId(value: string) {
  const hash = createHash("sha1").update(value).digest("hex").padEnd(32, "0");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function words(value: string) {
  return Array.from(
    new Set(
      String(value || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]+/g, " ")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 1),
    ),
  );
}

function tokenBigrams(tokens: string[]) {
  const pairs: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (left && right) pairs.push(`${left}_${right}`);
  }
  return pairs;
}

function l2Normalize(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) return vector;
  return vector.map((value) => value / norm);
}

function hashEmbedText(text: string) {
  const vector = new Array(HASH_VECTOR_SIZE).fill(0);
  const baseTokens = words(text);
  const tokens = [...baseTokens, ...tokenBigrams(baseTokens).slice(0, 72)];

  for (const token of tokens) {
    const digest = createHash("sha1").update(token).digest();
    const index = digest.readUInt16BE(0) % HASH_VECTOR_SIZE;
    const sign = (digest[2] & 1) === 0 ? 1 : -1;
    const weight = token.includes("_") ? 1.2 : token.length >= 7 ? 1.12 : 1;
    vector[index] += sign * weight;
  }

  return l2Normalize(vector);
}

async function realEmbedText(text: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  headers.Authorization = ["Bear", "er"].join("") + " " + embeddingApiKey();

  const res = await fetch(`${embeddingBaseUrl()}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: embeddingModel(), input: text.slice(0, 8000) }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `Embedding HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : `Embedding HTTP ${res.status}`);
  }
  const vector = data?.data?.[0]?.embedding;
  if (!Array.isArray(vector) || !vector.length) throw new Error("Embedding response did not include a vector");
  return l2Normalize(vector.map((value: unknown) => Number(value || 0)));
}

async function embedText(text: string) {
  if (!realEmbeddingsEnabled()) return hashEmbedText(text);
  try {
    return await realEmbedText(text);
  } catch {
    embeddingsUnavailableUntil = Date.now() + 60_000;
    return hashEmbedText(text);
  }
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

function splitSection(source: string, section: string) {
  const chunkSize = Math.max(280, DEFAULT_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(DEFAULT_CHUNK_OVERLAP, Math.floor(chunkSize / 2)));
  const normalized = section.replace(/\n{3,}/g, "\n\n").trim();
  const pieces: Array<{ source: string; text: string }> = [];

  if (normalized.length <= chunkSize) {
    if (normalized) pieces.push({ source, text: normalized });
    return pieces;
  }

  const paragraphs = normalized.split(/\n\s*\n/g).map((item) => item.trim()).filter(Boolean);
  let buffer = "";
  for (const paragraph of paragraphs) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= chunkSize) {
      buffer = candidate;
      continue;
    }
    if (buffer) pieces.push({ source, text: buffer });
    if (paragraph.length <= chunkSize) {
      buffer = paragraph;
      continue;
    }
    for (let start = 0; start < paragraph.length; start += chunkSize - overlap) {
      const text = paragraph.slice(start, start + chunkSize).trim();
      if (text) pieces.push({ source, text });
      if (start + chunkSize >= paragraph.length) break;
    }
    buffer = "";
  }
  if (buffer) pieces.push({ source, text: buffer });

  if (overlap > 0 && pieces.length > 1) {
    return pieces.map((piece, index) => {
      const prev = index > 0 ? pieces[index - 1].text.slice(-overlap).trim() : "";
      return prev ? { ...piece, text: `${prev}\n\n${piece.text}`.trim() } : piece;
    });
  }

  return pieces;
}

function splitText(source: string, content: string) {
  const clean = content.replace(/\r/g, "").trim();
  if (!clean) return [] as Array<{ source: string; text: string }>;

  const sections = clean.split(/\n(?=#{1,3}\s)/g).filter(Boolean);
  const pool = sections.length ? sections : [clean];
  return pool.flatMap((section) => splitSection(source, section));
}

function sourceAudience(source: string): KnowledgeMode[] {
  const sourceName = source.toLowerCase();
  if (sourceName.includes("internal-ops")) return ["admin", "staff"];
  return ["customer", "staff", "admin"];
}

function sourceBoost(query: string, source: string, text: string) {
  const q = query.toLowerCase();
  const sourceName = source.toLowerCase();
  const content = text.toLowerCase();

  let boost = 0;

  if (/(open|opening|hours|close|address|location|phone|email|contact|giờ|mở cửa|địa chỉ|liên hệ)/i.test(q) && sourceName.includes("shop-info")) boost += 8;
  if (/(book|booking|cancel|reschedule|refund|change|policy|complaint|đặt lịch|huỷ|đổi lịch|hoàn tiền|chính sách)/i.test(q) && sourceName.includes("customer-policies")) boost += 6;
  if (/(photo|image|nail|bleeding|swelling|infection|lift|lifting|pain|ảnh|móng|đau|sưng|nhiễm trùng)/i.test(q) && sourceName.includes("photo-guidance")) boost += 6;
  if (/(choose|which|difference|compare|builder|biab|acrylic|gel|ombre|extensions|natural nail|overlay|chọn|khác nhau|so sánh)/i.test(q) && sourceName.includes("service-guidance")) boost += 6;
  if (/(faq|first time|what should i|what do i need|how do i|book|booking|photo|price|duration|giá|bao lâu|lần đầu)/i.test(q) && sourceName.includes("customer-faq")) boost += 5;
  if (/(revenue|staff|leave|availability|workload|schedule|operations|unassigned|queue|doanh thu|nhân viên|lịch|vận hành)/i.test(q) && sourceName.includes("internal-ops")) boost += 5;
  if (content.includes("opening hours") && /(open|opening|hours|giờ|mở cửa)/i.test(q)) boost += 3;
  if (content.includes("website booking flow") && /(book|booking|đặt lịch)/i.test(q)) boost += 2;
  if (sourceName.includes("soul")) boost -= 1;

  return boost;
}

async function loadCorpus() {
  if (corpusCache && Date.now() - corpusLoadedAt < CORPUS_TTL_MS) return corpusCache;

  const files = await walk(KNOWLEDGE_DIR);
  const chunks: KnowledgeChunk[] = [];

  for (const file of files) {
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    const rel = path.relative(KNOWLEDGE_DIR, file) || path.basename(file);
    const audiences = sourceAudience(rel);
    const pieces = splitText(rel, raw);
    for (let index = 0; index < pieces.length; index += 1) {
      const item = pieces[index];
      chunks.push({
        source: item.source,
        text: item.text,
        score: 0,
        id: stableId(`${item.source}:${index}:${item.text}`),
        audiences,
        vector: await embedText(`${item.source}\n${item.text}`),
      });
    }
  }

  corpusCache = chunks;
  corpusLoadedAt = Date.now();
  return chunks;
}

function diversify(results: RetrievedChunk[], limit: number) {
  const picked: RetrievedChunk[] = [];
  const seenPerSource = new Map<string, number>();
  const maxPerSource = numericEnv(["CHATBOT_MAX_CHUNKS_PER_SOURCE"], 2);
  for (const item of results) {
    const count = seenPerSource.get(item.source) || 0;
    if (count >= maxPerSource) continue;
    picked.push(item);
    seenPerSource.set(item.source, count + 1);
    if (picked.length >= limit) break;
  }
  return picked;
}

function lexicalRetrieve(query: string, corpus: KnowledgeChunk[], limit: number) {
  const q = words(query);
  const scored = corpus
    .map((item) => {
      const hay = item.text.toLowerCase();
      const score = q.reduce((sum, token) => sum + (hay.includes(token) ? 1 : 0), 0) + (hay.includes(query.toLowerCase()) ? 4 : 0) + sourceBoost(query, item.source, item.text);
      return { source: item.source, text: item.text, score } satisfies RetrievedChunk;
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const diversified = diversify(scored, limit);
  return diversified.length ? diversified : corpus.slice(0, Math.min(limit, corpus.length)).map((item) => ({ source: item.source, text: item.text, score: 0 }));
}

async function qdrantRequest(method: string, apiPath: string, body?: unknown) {
  const base = qdrantUrl();
  if (!base) throw new Error("Qdrant URL is not configured");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = qdrantApiKey();
  if (apiKey) headers["api-key"] = apiKey;

  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) {
    const detail = data?.status?.error || data?.result?.error || data?.error || `Qdrant HTTP ${res.status}`;
    throw new Error(typeof detail === "string" ? detail : `Qdrant HTTP ${res.status}`);
  }
  return data;
}

function corpusSignature(corpus: KnowledgeChunk[]) {
  return stableId(corpus.map((item) => item.id).join("|"));
}

function qdrantVectorSize(collection: any) {
  return Number(
    collection?.result?.config?.params?.vectors?.size ||
      collection?.result?.config?.params?.vectors?.default?.size ||
      collection?.config?.params?.vectors?.size ||
      0,
  );
}

async function ensureQdrantCollection(vectorSize: number) {
  try {
    const existing = await qdrantRequest("GET", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}`);
    const existingSize = qdrantVectorSize(existing);
    if (!existingSize || existingSize === vectorSize) return;
    if (!flagEnv(["QDRANT_RECREATE_COLLECTION", "CHATBOT_QDRANT_RECREATE_COLLECTION"], false)) {
      throw new Error(`Qdrant collection ${QDRANT_COLLECTION} vector size is ${existingSize}, expected ${vectorSize}. Set a new QDRANT_COLLECTION or enable QDRANT_RECREATE_COLLECTION=1.`);
    }
    await qdrantRequest("DELETE", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("HTTP 404") && !message.includes("Not found") && !message.includes("Not found: Collection")) {
      if (!message.includes("vector size")) {
        // continue to PUT for missing collection; rethrow real size mismatch unless recreate allowed above
      } else {
        throw error;
      }
    }
  }

  await qdrantRequest("PUT", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}`, {
    vectors: {
      size: vectorSize,
      distance: "Cosine",
    },
  });
}

async function syncKnowledgeToQdrantInternal(corpus: KnowledgeChunk[]) {
  if (!qdrantEnabled()) return { enabled: false, synced: false, chunks: corpus.length, collection: QDRANT_COLLECTION, engine: realEmbeddingsEnabled() ? "embedding" : "hash" };

  const signature = corpusSignature(corpus);
  const fresh = signature === lastQdrantSignature && Date.now() - lastQdrantSyncAt < QDRANT_SYNC_TTL_MS;
  if (fresh) return { enabled: true, synced: false, chunks: corpus.length, collection: QDRANT_COLLECTION, engine: realEmbeddingsEnabled() ? "embedding" : "hash" };

  const vectorSize = corpus[0]?.vector.length || expectedVectorSize();
  await ensureQdrantCollection(vectorSize);
  await qdrantRequest("POST", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points/delete?wait=true`, {
    filter: {
      must: [{ key: "app", match: { value: QDRANT_APP_TAG } }],
    },
  });

  for (let start = 0; start < corpus.length; start += 64) {
    const batch = corpus.slice(start, start + 64);
    await qdrantRequest("PUT", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points?wait=true`, {
      points: batch.map((item) => ({
        id: item.id,
        vector: item.vector,
        payload: {
          app: QDRANT_APP_TAG,
          source: item.source,
          text: item.text,
          audiences: item.audiences,
        },
      })),
    });
  }

  lastQdrantSignature = signature;
  lastQdrantSyncAt = Date.now();
  return { enabled: true, synced: true, chunks: corpus.length, collection: QDRANT_COLLECTION, engine: realEmbeddingsEnabled() ? "embedding" : "hash" };
}

async function qdrantRetrieve(query: string, mode: KnowledgeMode, limit: number) {
  const result = await qdrantRequest("POST", `/collections/${encodeURIComponent(QDRANT_COLLECTION)}/points/search`, {
    vector: await embedText(query),
    limit: Math.max(limit * 4, 16),
    with_payload: true,
    filter: {
      must: [{ key: "app", match: { value: QDRANT_APP_TAG } }],
    },
  });

  const rows: QdrantPoint[] = Array.isArray(result?.result) ? result.result : [];
  const reranked = rows
    .map((row) => {
      const source = String(row.payload?.source || "").trim();
      const text = String(row.payload?.text || "").trim();
      const audiences = Array.isArray(row.payload?.audiences) ? row.payload!.audiences! : [];
      if (!source || !text || !audiences.includes(mode)) return null;
      const baseScore = Number(row.score || 0);
      return {
        source,
        text,
        score: baseScore + sourceBoost(query, source, text) + (text.toLowerCase().includes(query.toLowerCase()) ? 2 : 0),
      } satisfies RetrievedChunk;
    })
    .filter(Boolean)
    .sort((a, b) => (b?.score || 0) - (a?.score || 0)) as RetrievedChunk[];

  return diversify(reranked, limit);
}

export async function retrieveKnowledgeTrace(query: string, mode: KnowledgeMode, limit = DEFAULT_TOP_K) {
  const corpus = (await loadCorpus()).filter((item) => item.audiences.includes(mode));
  if (!corpus.length) return { chunks: [] as RetrievedChunk[], engine: "lexical" as const };

  if (qdrantEnabled()) {
    try {
      await syncKnowledgeToQdrantInternal(await loadCorpus());
      const qdrantResults = await qdrantRetrieve(query, mode, limit);
      if (qdrantResults.length) return { chunks: qdrantResults, engine: "qdrant" as const };
    } catch {
      // Fall back to lexical retrieval below; the assistant must remain usable if vector infra is down.
    }
  }

  return { chunks: lexicalRetrieve(query, corpus, limit), engine: "lexical" as const };
}

export async function retrieveKnowledge(query: string, mode: KnowledgeMode, limit = DEFAULT_TOP_K) {
  const result = await retrieveKnowledgeTrace(query, mode, limit);
  return result.chunks;
}

export async function syncKnowledgeToQdrant(force = false) {
  const corpus = await loadCorpus();
  if (force) {
    lastQdrantSignature = "";
    lastQdrantSyncAt = 0;
  }
  return syncKnowledgeToQdrantInternal(corpus);
}

export async function knowledgeStats() {
  const corpus = await loadCorpus();
  return {
    qdrantEnabled: qdrantEnabled(),
    collection: QDRANT_COLLECTION,
    appTag: QDRANT_APP_TAG,
    vectorSize: corpus[0]?.vector.length || expectedVectorSize(),
    vectorEngine: realEmbeddingsEnabled() ? "embedding" : "hash-fallback",
    embeddingModel: realEmbeddingsEnabled() ? embeddingModel() : null,
    topK: DEFAULT_TOP_K,
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    chunks: corpus.length,
    sources: Array.from(new Set(corpus.map((item) => item.source))),
  };
}
