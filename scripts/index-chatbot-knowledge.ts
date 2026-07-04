import { knowledgeStats, syncKnowledgeToQdrant } from "../src/lib/chatbot-rag";

async function main() {
  const before = await knowledgeStats();
  const sync = await syncKnowledgeToQdrant(true);
  const after = await knowledgeStats();
  console.log(JSON.stringify({ before, sync, after }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
