import { knowledgeStats, retrieveKnowledge, syncKnowledgeToQdrant } from "../src/lib/chatbot-rag";
import { generateAssistantReply } from "../src/lib/chatbot";

async function main() {
  const stats = await knowledgeStats();
  const sync = await syncKnowledgeToQdrant(true);
  const query = process.argv.slice(2).join(" ").trim() || "What are your opening hours and how do I book an appointment?";
  const retrieved = await retrieveKnowledge(query, "customer", 5);
  const reply = await generateAssistantReply({
    messages: [{ role: "user", content: query }],
    mode: "customer",
    page: "/booking",
  });

  console.log(JSON.stringify({
    stats,
    sync,
    query,
    topChunks: retrieved.map((item, index) => ({
      rank: index + 1,
      source: item.source,
      score: Number(item.score || 0).toFixed(4),
      preview: item.text.replace(/\s+/g, " ").slice(0, 180),
    })),
    answerPreview: reply.answer.slice(0, 500),
    knowledgeEngine: reply.knowledgeEngine,
    sources: reply.sources,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
