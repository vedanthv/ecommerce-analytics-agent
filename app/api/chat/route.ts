import { NextRequest } from "next/server";
import { vectorSearch } from "@/lib/databricks";
import { callLLM } from "@/lib/llm";
import { endMlflowRun, logMlflowMetrics, logMlflowParams, logMlflowTags, startMlflowRun } from "@/lib/mlflow";
import OpenAI from "openai";
import redis from "@/lib/redis"; 
import fs from "fs";
import path from "path";
import { createHash } from "crypto";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export const runtime = "nodejs";

const CLASSIFIER_MODEL = "gpt-4o-mini";
const SUMMARY_MODEL = "gpt-4o-mini";
const FOLLOWUPS_MODEL = "gpt-4o-mini";
const RAG_RESPONSE_MODEL = "gpt-4o-mini";
const DOMAIN_GUARD_MODEL = "gpt-4o-mini";
const DOMAIN_GUARD_CACHE_TTL_SECONDS = 900;

type QueryContext = Record<string, Array<string | number>>;

const DOMAIN_REFUSAL_MESSAGE =
  "I can only help with questions grounded in your ecommerce and user activity data. Please ask about orders, customers, payments, shipping, sales, user behaviour, sessions, clicks, conversions, or related analytics from your dataset.";

const GREETING_REGEX = /^(hi|hello|hey|yo|good\s+morning|good\s+afternoon|good\s+evening|hola)\b[\s!,.?]*$/i;
const EXPLAINABILITY_REGEX = /\b(explain|how)\b.*\b(generate|generated|answer|response|responded|came up with)\b|\bhow did you (generate|answer|respond)\b/i;

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

function summarizeContext(rows: Array<Record<string, unknown>>, existingContext?: QueryContext | null): QueryContext | null {
  if (!rows || rows.length === 0) return existingContext || null;

  const sample = rows.slice(0, 5); // limit size
  const keys = Object.keys(sample[0]);

  // Capture ALL fields (not just IDs) to preserve full context
  const summary: QueryContext = existingContext ? { ...existingContext } : {};

  for (const field of keys) {
    const newValues = sample
      .map((r) => r[field])
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number");
    
    if (newValues.length === 0) continue; // Skip if no valid values
    
    // Merge with existing values, avoiding duplicates
    if (summary[field]) {
      const existing = new Set(summary[field]);
      summary[field] = [...existing, ...newValues.filter(v => !existing.has(v))];
    } else {
      summary[field] = newValues;
    }
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

function normalizeQuestionForCache(question: string) {
  return (question || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getDomainCacheKey(question: string, sessionId?: string) {
  const normalized = normalizeQuestionForCache(question);
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `domain_guard:${sessionId || "anon"}:${digest}`;
}

function isGreetingMessage(question: string) {
  return GREETING_REGEX.test((question || "").trim());
}

function isExplainabilityRequest(question: string) {
  return EXPLAINABILITY_REGEX.test((question || "").trim().toLowerCase());
}

async function classifyDomain(
  question: string,
  history: any[] = [],
  context: QueryContext | null = null,
  sessionId?: string
) {
  const normalizedQuestion = normalizeQuestionForCache(question);
  if (!normalizedQuestion) {
    return {
      allowed: false,
      confidence: 1,
      reasoning: "Empty question",
    };
  }

  if (isGreetingMessage(question)) {
    return {
      allowed: true,
      confidence: 1,
      reasoning: "Greeting message",
    };
  }

  if (isExplainabilityRequest(question)) {
    return {
      allowed: true,
      confidence: 1,
      reasoning: "Explainability request about assistant behavior",
    };
  }

  const cacheKey = getDomainCacheKey(question, sessionId);
  try {
    const cached = await redis.get(cacheKey);
    if (cached && typeof cached === "string") {
      const parsed = JSON.parse(cached);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.allowed === "boolean" &&
        typeof parsed.confidence === "number" &&
        typeof parsed.reasoning === "string"
      ) {
        return parsed;
      }
    }
  } catch {
    // If cache fails, continue with live classification.
  }

  const historyText = history
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-2000);

  const contextText = context ? JSON.stringify(context).slice(0, 10000) : "";

  const prompt = `You are a strict domain classifier for an ecommerce analytics assistant.
Classify if the user question is in-domain for ecommerce business/data analytics.

In-domain examples:
- orders, customers, products, payments, refunds, returns, shipping, fulfillment, revenue, sales, conversion, retention
- user activity and behaviour analytics: clicks, sessions, page views, events, device type, browser, scroll depth, load time, referrer, conversions, which user, top users, user ranking, experiment flags, feature flags, ad campaigns, app version, network, location, event types
- SQL/data questions about ecommerce datasets or user activity datasets
- follow-ups referencing previous ecommerce or user activity answers in conversation context

Out-of-domain examples:
- general trivia, coding help unrelated to ecommerce data, weather, sports, politics, personal advice

Return pure JSON only:
{
  "allowed": true or false,
  "confidence": 0.0-1.0,
  "reasoning": "short reason"
}

Conversation history:
${historyText || "(none)"}

Session context summary:
${contextText || "(none)"}

User question:
${question}`;

  const res = await openai.chat.completions.create({
    model: DOMAIN_GUARD_MODEL,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });

  const rawContent = res.choices[0].message.content || "";
  try {
    const parsed = JSON.parse(rawContent);
    const decision = {
      allowed: Boolean(parsed?.allowed),
      confidence: Number(parsed?.confidence ?? 0.5),
      reasoning: String(parsed?.reasoning ?? "No reasoning"),
    };

    try {
      await redis
        .pipeline()
        .set(cacheKey, JSON.stringify(decision))
        .expire(cacheKey, DOMAIN_GUARD_CACHE_TTL_SECONDS)
        .exec();
    } catch {
      // Ignore cache write failure.
    }

    return decision;
  } catch {
    // Fail-safe default is to block when classifier output is invalid.
    return {
      allowed: false,
      confidence: 0,
      reasoning: "Domain classifier parse failed",
    };
  }
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
  if (!context || !sessionId) return;

  const ctxKey = `chat_ctx:${sessionId}`;
  try {
    // Get existing context and merge
    const existing = await getSessionContext(sessionId);
    const merged = existing ? { ...existing, ...context } : context;
    
    // Merge arrays of IDs, removing duplicates
    for (const key of Object.keys(merged)) {
      if (Array.isArray(merged[key])) {
        merged[key] = [...new Set(merged[key])];
      }
    }
    
    await redis
      .pipeline()
      .set(ctxKey, JSON.stringify(merged))
      .expire(ctxKey, 86400) // 24 hours for whole-session persistence
      .exec();
  } catch (e) {
    console.error("Failed to save session context:", e);
  }
}

async function generateSQL(question: string, history: any[] = []) {
  const historyText = history
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-10000); // Keep last 10K chars of history to avoid token limits

  const template = getPromptTemplate();

  const contextText = formatContextForPrompt(lastQueryContext);

  const prompt = template
  .replace(/{{history}}/g, historyText + contextText)
  .replace(/{{today}}/g, today)
  .replace(/{{question}}/g, question);

  const res = await openai.chat.completions.create({
    model: CLASSIFIER_MODEL,
    temperature: 0,
    messages: [{ role: "user", content: prompt }],
  });
  
  const rawContent = res.choices[0].message.content!;
  
  // Parse JSON response
  try {
    const parsed = JSON.parse(rawContent);
    return parsed;
  } catch (e) {
    console.error("Failed to parse classifier JSON:", rawContent);
    // Fallback: treat as RAG if JSON parsing fails
    return { route: "RAG", confidence: 0.5, reasoning: "Parser error", sql: null };
  }
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
    .ltrim(key, -200, -1)
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

Dont give questions please. Give some suggestions for additional insights that are useful for the user. 

Question: ${question}
Answer: ${answer}
`;

  const res = await openai.chat.completions.create({
    model: FOLLOWUPS_MODEL,
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
  const { question, history, sessionId } = await req.json();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const t0 = performance.now();
      const requestId = crypto.randomUUID();
      const timings: Record<string, number> = {};
      const key = `chat:${sessionId}`;
      let mlflowRunId = "";

      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      const stepStart = (id: string, label: string) => {
        emit({ type: "step", id, label, status: "active" });
      };

      const stepDone = (id: string, label: string) => {
        emit({ type: "step", id, label, status: "completed" });
      };

      const stepError = (id: string, label: string) => {
        emit({ type: "step", id, label, status: "error" });
      };

      try {
        stepStart("init", "Preparing request");
        mlflowRunId = await startMlflowRun({
          endpoint: "api_chat",
          request_id: requestId,
          session_id: String(sessionId ?? "unknown"),
        });

        await logMlflowTags(mlflowRunId, {
          "genai.app": "orders-ai-agent",
          "genai.use_case": "customer_support_analytics",
          "genai.provider": "openai",
          "genai.pipeline": "classifier_sql_rag_hybrid",
        });

        await logMlflowParams(mlflowRunId, {
          question_len: String((question ?? "").length),
          has_history: String(Boolean(history?.length)),
          has_session: String(Boolean(sessionId)),
          model_classifier: CLASSIFIER_MODEL,
          model_domain_guard: DOMAIN_GUARD_MODEL,
          model_summary: SUMMARY_MODEL,
          model_followups: FOLLOWUPS_MODEL,
          model_rag_response: RAG_RESPONSE_MODEL,
        });
        stepDone("init", "Preparing request");

        stepStart("history", "Loading session context");
        const sessionContext = await getSessionContext(sessionId);
        if (sessionContext) {
          lastQueryContext = sessionContext;
        }
        
        // Helper to save context before closing stream
        const closeWithContextSave = async () => {
          if (sessionId && lastQueryContext) {
            await saveSessionContext(sessionId, lastQueryContext);
          }
        };

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
          ? redisHistory
          : history || [];

        if (sessionId) {
          await appendHistory(key, "user", question);
        }
        stepDone("history", "Loading session context");

        const effectiveContext = sessionContext || lastQueryContext;

        if (isGreetingMessage(question)) {
          const greetingAnswer =
            "Hello! I can help with ecommerce analytics from your data, including orders, customers, payments, shipping, and sales trends. Ask a question like: 'Show revenue trend for the last 30 days.'";

          if (sessionId) {
            await appendHistory(key, "assistant", greetingAnswer);
          }

          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            route_sql: 0,
            meta: 1,
          });
          await logMlflowParams(mlflowRunId, {
            route_mode: "META_GREETING",
            forced_sql: "false",
          });
          await endMlflowRun(mlflowRunId, "FINISHED");

          emit({
            type: "final",
            payload: {
              answer: greetingAnswer,
              table: [],
              followUps: [],
              mode: "META",
              reason: "Greeting message.",
              classifier_confidence: 1,
              context: effectiveContext,
              requestId,
            },
          });

          await closeWithContextSave();
          controller.close();
          return;
        }

        if (isExplainabilityRequest(question)) {
          const explainHistoryText = finalHistory
            .map((m: any) => `${m.role}: ${m.content}`)
            .join("\n")
            .slice(-5000);

          const explainContextText = effectiveContext
            ? JSON.stringify(effectiveContext).slice(0, 1200)
            : "(none)";

          const explainAnswer =
            (await callLLM([
              {
                role: "system",
                content:
                  "You explain how this ecommerce assistant produced answers. Be transparent, concise, and factual. Mention: domain policy check, SQL vs RAG routing, use of retrieved context or SQL results, and short-term session context for follow-ups. Do not reveal secrets, API keys, or internal chain-of-thought. If a detail is unknown, clearly say so.",
              },
              {
                role: "user",
                content: `User request: ${question}\n\nRecent conversation:\n${explainHistoryText || "(none)"}\n\nSession context summary:\n${explainContextText}\n\nWrite a clear explanation for a business user in 4-7 sentences.`,
              },
            ])) ||
            "I check domain policy first, then choose SQL analytics or retrieval-based response, and ground the answer in your data context.";

          if (sessionId) {
            await appendHistory(key, "assistant", explainAnswer);
          }

          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            route_sql: 0,
            meta: 1,
          });
          await logMlflowParams(mlflowRunId, {
            route_mode: "META_EXPLAIN",
            forced_sql: "false",
          });
          await endMlflowRun(mlflowRunId, "FINISHED");

          emit({
            type: "final",
            payload: {
              answer: explainAnswer,
              table: [],
              followUps: [],
              mode: "META",
              reason: "Explainability request.",
              classifier_confidence: 1,
              context: effectiveContext,
              requestId,
            },
          });

          await closeWithContextSave();
          controller.close();
          return;
        }

        stepStart("policy", "Checking domain eligibility");
        const tPolicy0 = performance.now();
        const domainGuard = await classifyDomain(question, finalHistory, effectiveContext, sessionId);
        timings.policy_ms = Math.round(performance.now() - tPolicy0);
        stepDone("policy", "Checking domain eligibility");

        if (!domainGuard.allowed) {
          stepStart("policy", "Applying domain policy");
          stepDone("policy", "Applying domain policy");

          if (sessionId) {
            await appendHistory(key, "assistant", DOMAIN_REFUSAL_MESSAGE);
          }

          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            route_sql: 0,
            blocked: 1,
          });
          await logMlflowParams(mlflowRunId, {
            route_mode: "BLOCKED",
            forced_sql: "false",
          });
          await endMlflowRun(mlflowRunId, "FINISHED");

          emit({
            type: "final",
            payload: {
              answer: DOMAIN_REFUSAL_MESSAGE,
              table: [],
              followUps: [],
              mode: "BLOCKED",
              reason: `Question is out of ecommerce/data domain. ${domainGuard.reasoning}`,
              classifier_confidence: parseFloat(domainGuard.confidence.toFixed(2)),
              context: effectiveContext,
              requestId,
            },
          });

          await closeWithContextSave();
          controller.close();
          return;
        }

        stepStart("classify", "Classifying intent");
        const tClassify0 = performance.now();
        const classificationResult = await generateSQL(question, finalHistory);
        timings.classify_ms = Math.round(performance.now() - tClassify0);
        stepDone("classify", "Classifying intent");

        const {
          route: rawRoute = "RAG",
          confidence = 0.5,
          reasoning = "Unknown",
          sql: classifiedSQL = null,
        } = classificationResult;

        const classifiedRoute = String(rawRoute).trim().toUpperCase();

        if (classifiedRoute === "BLOCKED") {
          if (sessionId) {
            await appendHistory(key, "assistant", DOMAIN_REFUSAL_MESSAGE);
          }

          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            route_sql: 0,
            blocked: 1,
          });
          await logMlflowParams(mlflowRunId, {
            route_mode: "BLOCKED",
            forced_sql: "false",
          });
          await endMlflowRun(mlflowRunId, "FINISHED");

          emit({
            type: "final",
            payload: {
              answer: DOMAIN_REFUSAL_MESSAGE,
              table: [],
              followUps: [],
              mode: "BLOCKED",
              reason: "Classifier marked question as out of ecommerce/data domain.",
              classifier_confidence: parseFloat((confidence ?? 1).toFixed(2)),
              context: lastQueryContext,
              requestId,
            },
          });

          await closeWithContextSave();
          controller.close();
          return;
        }

        let useSQL = false;
        let forcedSql = false;
        let finalDecisionReason = reasoning;

        if (confidence >= 0.85 && classifiedRoute === "SQL") {
          useSQL = true;
          forcedSql = false;
        } else if (confidence >= 0.85 && classifiedRoute === "RAG") {
          useSQL = false;
          forcedSql = false;
        } else if (confidence >= 0.7 && classifiedRoute === "SQL") {
          useSQL = true;
          forcedSql = false;
        } else {
          useSQL = false;
          forcedSql = false;
          finalDecisionReason = `Low confidence (${confidence.toFixed(2)}). Defaulting to RAG. ${reasoning}`;
        }

        const decisionReason = finalDecisionReason;

        stepStart("route", "Choosing response strategy");
        emit({
          type: "step_note",
          id: "route",
          label: `Route selected: ${useSQL ? "SQL" : "RAG"}`,
        });
        stepDone("route", "Choosing response strategy");

        if (useSQL) {
          await logMlflowParams(mlflowRunId, {
            route_mode: "SQL",
            forced_sql: String(forcedSql),
            classifier_confidence: String(confidence.toFixed(2)),
          });

          stepStart("sql", "Running SQL query");
          const sql = cleanSQL(classifiedSQL || "");
          const tSqlExec0 = performance.now();
          const result = await runSQL(sql);
          timings.sql_exec_ms = Math.round(performance.now() - tSqlExec0);
          stepDone("sql", "Running SQL query");

          const newContext = summarizeContext(result, lastQueryContext);
          lastQueryContext = newContext;
          if (sessionId) {
            await saveSessionContext(sessionId, newContext);
          }

          if (!result || result.length === 0) {
            stepStart("fallback", "No rows found, switching to retrieval");
            const tRetrieval0 = performance.now();
            const { context } = await vectorSearch(question);
            timings.retrieval_ms = Math.round(performance.now() - tRetrieval0);

            const tRagLlm0 = performance.now();
            const ragAnswer = await callLLM([
              {
                role: "system",
                content: "Tell user that a full query failed, then answer using context.",
              },
              {
                role: "user",
                content: `Q: ${question}\n\nContext:\n${context}`,
              },
            ]);
            timings.rag_llm_ms = Math.round(performance.now() - tRagLlm0);
            stepDone("fallback", "No rows found, switching to retrieval");

            stepStart("followups", "Generating follow-up suggestions");
            const followUps = await generateFollowUps(question, ragAnswer).catch(() => []);
            stepDone("followups", "Generating follow-up suggestions");

            if (sessionId) {
              await appendHistory(key, "assistant", ragAnswer);
            }

            timings.total_ms = Math.round(performance.now() - t0);
            await logMlflowMetrics(mlflowRunId, {
              ...timings,
              route_sql: 1,
              fallback_to_rag: 1,
              sql_rows: 0,
            });
            await endMlflowRun(mlflowRunId, "FINISHED");

            emit({
              type: "final",
              payload: {
                answer: ragAnswer,
                table: [],
                followUps,
                mode: "RAG",
                reason: "SQL returned no rows; switched to retrieval context.",
                classifier_confidence: parseFloat(confidence.toFixed(2)),
                context: lastQueryContext,
                requestId,
              },
            });

            await closeWithContextSave();
            controller.close();
            return;
          }

          stepStart("summarize", "Summarizing SQL results");
          const tSummary0 = performance.now();
          const summaryRes = await openai.chat.completions.create({
            model: SUMMARY_MODEL,
            messages: [
              {
                role: "user",
                content: `Question: ${question}\nData: ${JSON.stringify(result)}`,
              },
            ],
          });
          timings.summary_llm_ms = Math.round(performance.now() - tSummary0);
          const summary = summaryRes.choices[0].message.content || "No meaningful data found";
          stepDone("summarize", "Summarizing SQL results");

          stepStart("followups", "Generating follow-up suggestions");
          const followUps = await generateFollowUps(question, summary).catch(() => []);
          stepDone("followups", "Generating follow-up suggestions");

          if (sessionId) {
            await appendHistory(key, "assistant", summary);
          }

          const totalRows = result.length;
          const displayedRows = Math.min(10, result.length);
          const tableDisplay = result.slice(0, 10);
          const hasMoreRows = totalRows > 10;

          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            route_sql: 1,
            fallback_to_rag: 0,
            sql_rows: result.length,
          });
          await endMlflowRun(mlflowRunId, "FINISHED");

          emit({
            type: "final",
            payload: {
              answer: summary,
              table: tableDisplay,
              totalRows,
              displayedRows,
              hasMoreRows,
              followUps,
              mode: "SQL",
              reason: decisionReason,
              classifier_confidence: parseFloat(confidence.toFixed(2)),
              context: lastQueryContext,
              requestId,
            },
          });

        await closeWithContextSave();
controller.close();
          return;
        }

        await logMlflowParams(mlflowRunId, {
          route_mode: "RAG",
          forced_sql: String(forcedSql),
        });

        stepStart("retrieve", "Retrieving relevant context");
        const tRetrieval0 = performance.now();
        const { context } = await vectorSearch(question);
        timings.retrieval_ms = Math.round(performance.now() - tRetrieval0);
        stepDone("retrieve", "Retrieving relevant context");

        stepStart("draft", "Drafting response");
        const tRagLlm0 = performance.now();
        const rawAnswer = await callLLM([
          {
            role: "system",
            content:
              "You are an ecommerce data assistant. Only answer questions about ecommerce data and business topics such as orders, customers, payments, shipping, sales, delivery, and related analytics. Use only the provided context and conversation. If the request is unrelated or not supported by the context, reply exactly with: \"I can only help with ecommerce questions grounded in your order and customer data. Please ask about orders, customers, payments, shipping, sales, or related analytics from your dataset.\"",
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
        timings.rag_llm_ms = Math.round(performance.now() - tRagLlm0);

        let fullText = "";
        const chunkSize = 64;
        for (let i = 0; i < rawAnswer.length; i += chunkSize) {
          const chunk = rawAnswer.slice(i, i + chunkSize);
          fullText += chunk;
          emit({ type: "answer_chunk", chunk });
        }
        stepDone("draft", "Drafting response");

        if (sessionId) {
          await appendHistory(key, "assistant", fullText);
        }

        stepStart("followups", "Generating follow-up suggestions");
        const followUps = await generateFollowUps(question, rawAnswer).catch(() => []);
        stepDone("followups", "Generating follow-up suggestions");

        timings.total_ms = Math.round(performance.now() - t0);
        await logMlflowMetrics(mlflowRunId, {
          ...timings,
          route_sql: 0,
          fallback_to_rag: 0,
          answer_chars: rawAnswer.length,
        });
        await endMlflowRun(mlflowRunId, "FINISHED");

        emit({
          type: "final",
          payload: {
            answer: rawAnswer,
            table: [],
            followUps,
            mode: "RAG",
            reason: decisionReason,
            classifier_confidence: parseFloat(confidence.toFixed(2)),
            context: lastQueryContext,
            requestId,
          },
        });

        await closeWithContextSave();
controller.close();
      } catch (e: any) {
        emit({ type: "error", message: e?.message || "Unexpected server error" });
        if (mlflowRunId) {
          timings.total_ms = Math.round(performance.now() - t0);
          await logMlflowMetrics(mlflowRunId, {
            ...timings,
            failed: 1,
          }).catch(() => undefined);
          await endMlflowRun(mlflowRunId, "FAILED").catch(() => undefined);
        }

        stepError("finalize", "Request failed");
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}