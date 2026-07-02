import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateAssistantReply, type ChatMessage } from "@/lib/chatbot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { messages?: ChatMessage[]; page?: string };

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const messages = Array.isArray(body.messages)
      ? body.messages
          .map((item) => ({ role: item?.role, content: String(item?.content || "").trim() }))
          .filter((item) => (item.role === "user" || item.role === "assistant" || item.role === "system") && item.content)
      : [];

    if (!messages.length) return NextResponse.json({ error: "Message is required" }, { status: 400 });

    const services = await prisma.service.findMany({
      where: { active: true },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      select: { name: true, category: true, price: true, duration: true, description: true },
    }).catch(() => []);

    const servicesText = services
      .map((service) => {
        const price = Number(service.price || 0).toFixed(2);
        const note = service.description ? ` — ${service.description}` : "";
        return `- ${service.name} (${service.category}) · £${price} · ${service.duration} min${note}`;
      })
      .join("\n");

    const result = await generateAssistantReply({ messages, page: body.page, servicesText });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chat assistant failed" },
      { status: 500 },
    );
  }
}
