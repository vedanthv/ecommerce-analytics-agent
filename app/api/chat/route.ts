import { NextRequest } from "next/server";
import { vectorSearch } from "@/lib/databricks";
import { callLLM } from "@/lib/llm";
import OpenAI from "openai";
import redis from "@/lib/redis"; 

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

// ================= ROUTER =================

async function shouldUseSQL(question: string) {
  const prompt = `
Classify the query.

Return ONLY one word:
SQL or RAG

Rules:
- SQL → aggregations, totals, trends, peak, highest, lowest
- RAG → explanations, descriptions, specific records

Query:
${question}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const decision = res.choices[0].message.content?.trim();
  return decision === "SQL";
}

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

async function generateSQL(question: string) {
  const prompt = `
You are a SQL generator.
...
Question: ${question}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return cleanSQL(res.choices[0].message.content!);
}

async function runSQL(query: string) {
  const res = await fetch(process.env.DATABRICKS_SQL_URL!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      statement: query,
      warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID,
      wait_timeout: "30s",
    }),
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
}

// ================= FOLLOW UPS =================

async function generateFollowUps(question: string, answer: string) {
  const prompt = `
Generate 3 short follow-up responses.
...
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
  const { question, history, sessionId } = await req.json(); // ✅ NEW

  const key = `chat:${sessionId}`;

  // ================= GET REDIS HISTORY =================
  let redisHistory: any[] = [];

  try {
    const stored = await redis.lrange(key, 0, -1);
    redisHistory = stored.map((m: string) => JSON.parse(m));
  } catch {
    redisHistory = [];
  }

  const finalHistory = redisHistory.length
    ? redisHistory.slice(-6)
    : history || [];

  // ================= STORE USER MESSAGE =================
  if (sessionId) {
    await redis.rpush(
      key,
      JSON.stringify({ role: "user", content: question })
    );
    await redis.ltrim(key, -20, -1);
    await redis.expire(key, 3600);
  }

  const useSQL = await shouldUseSQL(question);
  console.log("ROUTE:", useSQL ? "SQL" : "RAG");

  // ================= SQL ROUTE =================
  if (useSQL) {
    try {
      const sql = await generateSQL(question);
      const result = await runSQL(sql);

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

      const followUps = await generateFollowUps(question, summary);

      // ✅ STORE ASSISTANT RESPONSE
      if (sessionId) {
        await redis.rpush(
          key,
          JSON.stringify({ role: "assistant", content: summary })
        );
        await redis.ltrim(key, -20, -1);
        await redis.expire(key, 3600);
      }

      return new Response(
        JSON.stringify({
          answer: summary,
          table: result,
          followUps,
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
            content: `Q: ${question}\n\nContext:\n${context}`,
          },
        ]);

        const followUps = await generateFollowUps(question, rawAnswer);

        let fullText = "";

        for (const char of rawAnswer) {
          fullText += char;
          controller.enqueue(encoder.encode(char));
          await new Promise((r) => setTimeout(r, 5));
        }

        if (sessionId) {
          await redis.rpush(
            key,
            JSON.stringify({ role: "assistant", content: fullText })
          );
          await redis.ltrim(key, -20, -1);
          await redis.expire(key, 3600);
        }

        controller.enqueue(
          encoder.encode("\n__FOLLOWUPS__" + JSON.stringify(followUps))
        );

        controller.close();
      } catch (e: any) {
        controller.enqueue(encoder.encode("Error: " + e.message));
        controller.close();
      }
    },
  });

  return new Response(stream);
}