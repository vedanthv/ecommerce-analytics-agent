import { NextRequest } from "next/server";
import { vectorSearch } from "@/lib/databricks";
import { callLLM } from "@/lib/llm";
import OpenAI from "openai";
import redis from "@/lib/redis"; 
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export const runtime = "nodejs";

type QueryContext = Record<string, Array<string | number>>;

// ================= SQL HELPERS =================

function cleanSQL(sql: string) {
  let cleaned = sql
    .replace(/```sql/g, "")
    .replace(/```/g, "")
    .replace(/^sql\s*/i, "")
    .trim();

  cleaned = cleaned.replace(
    /customer_support_agent\.raw\.orders/gi,
    "customer_suppport_agent.raw.orders"
  );

  return cleaned;
}

const today = new Date().toISOString().split("T")[0];

let cachedPrompt: string | null = null;

function getPromptTemplate(): string {
  if (!cachedPrompt) {
    const filePath = path.join(process.cwd(), "prompts", "sql_rag_classifier.txt");
    cachedPrompt = fs.readFileSync(filePath, "utf-8");
  }
  return cachedPrompt;
}

let lastQueryContext: QueryContext | null = null;

function summarizeContext(rows: Array<Record<string, unknown>>): QueryContext | null {
  if (!rows || rows.length === 0) return null;

  const sample = rows.slice(0, 5); // limit size
  const keys = Object.keys(sample[0]);

  const idFields = keys.filter((k) =>
    k.toLowerCase().includes("id")
  );

  const summary: QueryContext = {};

  for (const field of idFields) {
    summary[field] = sample
      .map((r) => r[field])
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number");
  }

  return summary;
}

function formatContextForPrompt(context: QueryContext | null) {
  if (!context) return "";

  let text = "\nPrevious query result context:\n";

  for (const key of Object.keys(context)) {
    const values = context[key]
      .map((v: any) => `'${v}'`)
      .join(", ");

    text += `${key}: ${values}\n`;
  }

  return text;
}

function shouldForceSqlFollowUp(question: string, context: QueryContext | null) {
  if (!context) return false;

  const q = question.toLowerCase();
  const hasFollowUpReference = /\b(this|that|these|those|it|them|same)\b/.test(q);
  const hasShippingIntent = /\bshipping|delivery|instruction|address|fulfillment|dispatch\b/.test(q);
  const hasOrderIntent = /\border\b/.test(q);
  const hasOrderContext = Object.keys(context).some(
    (key) => key.toLowerCase() === "order_id" || key.toLowerCase().includes("order")
  );

  return hasOrderContext && (hasShippingIntent || (hasOrderIntent && hasFollowUpReference));
}

async function getSessionContext(sessionId?: string): Promise<QueryContext | null> {
  if (!sessionId) return null;

  try {
    const raw = await redis.get(`chat_ctx:${sessionId}`);
    if (!raw || typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as QueryContext) : null;
  } catch {
    return null;
  }
}

async function saveSessionContext(sessionId: string, context: QueryContext | null) {
  if (!context) return;

  const ctxKey = `chat_ctx:${sessionId}`;
  await redis
    .pipeline()
    .set(ctxKey, JSON.stringify(context))
    .expire(ctxKey, 3600)
    .exec();
}

async function generateSQL(question: string, history: any[] = []) {
  const historyText = history
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const template = getPromptTemplate();

  const contextText = formatContextForPrompt(lastQueryContext);

  const prompt = template
  .replace(/{{history}}/g, historyText + contextText)
  .replace(/{{today}}/g, today)
  .replace(/{{question}}/g, question);

  console.log(prompt.substring(0, 500));
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  return cleanSQL(res.choices[0].message.content!);
}

async function runSQL(query: string) {
  console.log("Running SQL:", query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const res = await fetch(process.env.DATABRICKS_SQL_URL!, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        statement: query,
        warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
        wait_timeout: "20s",
      }),
      signal: controller.signal,
    });

    const data = await res.json();

    const columns = data?.manifest?.schema?.columns || [];
    const rows = data?.result?.data_array || [];

    return rows.map((row: any[]) => {
      const obj: any = {};
      columns.forEach((col: any, i: number) => {
        obj[col.name] = row[i];
      });
      return obj;
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function appendHistory(key: string, role: "user" | "assistant", content: string) {
  await redis
    .pipeline()
    .rpush(key, JSON.stringify({ role, content }))
    .ltrim(key, -20, -1)
    .expire(key, 3600)
    .exec();
}

// ================= FOLLOW UPS =================

async function generateFollowUps(question: string, answer: string) {
  const prompt = `
Generate 3 short follow-up responses.

Rules:
- Max 10 words
- No numbering
- No symbols

Dont answer or give followups for general questions.

Question: ${question}
Answer: ${answer}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return (
    res.choices[0].message.content
      ?.split("\n")
      .map((q) => q.trim())
      .filter(Boolean)
      .slice(0, 3) || []
  );
}

// ================= MAIN =================

export async function POST(req: NextRequest) {
  const t0 = performance.now();
  const { question, history, sessionId } = await req.json(); 

  const key = `chat:${sessionId}`;
  const sessionContext = await getSessionContext(sessionId);
  if (sessionContext) {
    lastQueryContext = sessionContext;
  }

  let redisHistory: any[] = [];

  if (sessionId) {
    try {
      const stored = await redis.lrange(key, 0, -1);
      redisHistory = (stored || []).map((m: string) => JSON.parse(m));
    } catch {
      redisHistory = [];
    }
  }

  const finalHistory = redisHistory.length
    ? redisHistory.slice(-6)
    : history || [];

  if (sessionId) {
    await appendHistory(key, "user", question);
  }

  let sqlOrRag = await generateSQL(question, finalHistory);
  let useSQL = sqlOrRag.trim() !== "RAG";
  let forcedSql = false;

  if (!useSQL && shouldForceSqlFollowUp(question, lastQueryContext)) {
    const forcedQuestion = `${question}\n\nThis is a follow-up to previous SQL results. Resolve pronouns like 'this order' using previous context and return SQL only.`;
    sqlOrRag = await generateSQL(forcedQuestion, finalHistory);
    useSQL = sqlOrRag.trim() !== "RAG";
    forcedSql = useSQL;
  }

  const decisionReason = useSQL
    ? forcedSql
      ? "Follow-up referenced prior order context, so SQL mode was forced."
      : "Question was classified as structured analytics, so SQL mode was selected."
    : "Question was classified as unstructured retrieval, so RAG mode was selected.";

  console.log("ROUTE:", useSQL ? "SQL" : "RAG");

  // ================= SQL ROUTE =================
  if (useSQL) {
    try {
      const sql = sqlOrRag;
      const result = await runSQL(sql);
      console.log(result);
      lastQueryContext = summarizeContext(result);
      if (sessionId) {
        await saveSessionContext(sessionId, lastQueryContext);
      }
      if (!result || result.length === 0) {
        const { context } = await vectorSearch(question);

        const ragAnswer = await callLLM([
          {
            role: "system",
            content:
              "Tell user that a full query failed, then answer using context.",
          },
          {
            role: "user",
            content: `Q: ${question}\n\nContext:\n${context}`,
          },
        ]);

        return new Response(
          JSON.stringify({
            answer: ragAnswer,
            table: [],
            followUps: [],
            mode: "RAG",
            reason: "SQL returned no rows; switched to retrieval context.",
            context: lastQueryContext,
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      }

      const summaryRes = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `Question: ${question}\nData: ${JSON.stringify(result)}`,
          },
        ],
      });

      const summary =
        summaryRes.choices[0].message.content ||
        "No meaningful data found";

      const followUps = await generateFollowUps(question, summary).catch(() => []);

      if (sessionId) {
        await appendHistory(key, "assistant", summary);
      }

      console.info("[chat][SQL] total_ms", Math.round(performance.now() - t0));

      return new Response(
        JSON.stringify({
          answer: summary,
          table: result,
          followUps,
          mode: "SQL",
          reason: decisionReason,
          context: lastQueryContext,
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    } catch (e: any) {
      return new Response(
        JSON.stringify({ message: e.message }),
        { headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // ================= RAG ROUTE =================

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const { context } = await vectorSearch(question);

        const rawAnswer = await callLLM([
          {
            role: "system",
            content: `You are a helpful assistant.`,
          },
          ...finalHistory.map((msg: any) => ({
            role: msg.role,
            content: msg.content,
          })),
          {
            role: "user",
            content: `Q: ${question}${formatContextForPrompt(lastQueryContext)}\n\nContext:\n${context}`,
          },
        ]);

        const followUpsPromise = generateFollowUps(question, rawAnswer).catch(() => []);

        let fullText = "";

        const chunkSize = 64;
        for (let i = 0; i < rawAnswer.length; i += chunkSize) {
          const chunk = rawAnswer.slice(i, i + chunkSize);
          fullText += chunk;
          controller.enqueue(encoder.encode(chunk));
        }

        if (sessionId) {
          await appendHistory(key, "assistant", fullText);
        }

        const followUps = await followUpsPromise;

        controller.enqueue(
          encoder.encode("\n__FOLLOWUPS__" + JSON.stringify(followUps))
        );
        controller.enqueue(
          encoder.encode("\n__META__" + JSON.stringify({
            mode: "RAG",
            reason: decisionReason,
            context: lastQueryContext,
          }))
        );

        controller.close();
        console.info("[chat][RAG] total_ms", Math.round(performance.now() - t0));
      } catch (e: any) {
        controller.enqueue(encoder.encode("Error: " + e.message));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}