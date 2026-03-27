import axios from "axios";
import { Agent as HttpsAgent } from "https";

const HOST = process.env.DATABRICKS_HOST!;
const TOKEN = process.env.DATABRICKS_TOKEN!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
});

const openaiHttp = axios.create({
  baseURL: "https://api.openai.com/v1",
  timeout: 20_000,
  httpsAgent,
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "Content-Type": "application/json",
  },
});

const databricksHttp = axios.create({
  baseURL: HOST,
  timeout: 20_000,
  httpsAgent,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
});

const embeddingCache = new Map<string, { value: number[]; exp: number }>();
const EMBEDDING_TTL_MS = 5 * 60 * 1000;

export async function getEmbedding(text: string) {
  const key = text.trim().toLowerCase();
  const now = Date.now();
  const cached = embeddingCache.get(key);
  if (cached && cached.exp > now) {
    return cached.value;
  }

  const res = await openaiHttp.post("/embeddings", {
    model: "text-embedding-3-large",
    input: text,
    dimensions: 1024,
  });

  const embedding = res.data.data[0].embedding as number[];
  embeddingCache.set(key, { value: embedding, exp: now + EMBEDDING_TTL_MS });

  return embedding;
}

const INDEX_CONFIG = [
  {
    name: "customer_suppport_agent.raw.orders_index",
    columns: ["order_id", "text"],
    mapRow: (row: any) => ({
      id: row[0],
      text: row[1],
      score: row[row.length - 1] || 0,
      source: "orders",
    }),
  },
  {
    name: "customer_suppport_agent.raw.analytics_index",
    columns: ["session_id", "text"],
    mapRow: (row: any) => ({
      id: row[0],
      text: row[1], // normalize to "text"
      score: row[row.length - 1] || 0,
      source: "events",
    }),
  },
];

const FINAL_TOP_K = 10;

export async function vectorSearch(query: string) {
  const embedding = await getEmbedding(query);

  try {
    // -----------------------------------
    // 1. Query all indexes
    // -----------------------------------
    const responses = await Promise.all(
      INDEX_CONFIG.map((idx) =>
        databricksHttp.post(
          `/api/2.0/vector-search/indexes/${idx.name}/query`,
          {
            query_text: query,
            query_vector: embedding,
            query_type: "HYBRID",
            num_results: 8,
            columns: idx.columns,
          }
        )
      )
    );

    // -----------------------------------
    // 2. Normalize results per index
    // -----------------------------------
    let allResults: any[] = [];

    responses.forEach((res, i) => {
      const config = INDEX_CONFIG[i];

      const rows =
        res.data?.result?.data_array ||
        res.data?.data_array ||
        [];

      const mapped = rows.map(config.mapRow);

      // normalize scores within each index
      const maxScore = Math.max(...mapped.map((r: { score: any; }) => r.score), 1);

      mapped.forEach((r: { score: number; }) => {
        allResults.push({
          ...r,
          norm_score: r.score / maxScore,
        });
      });
    });

    // -----------------------------------
    // 3. Deduplicate (by text)
    // -----------------------------------
    const seen = new Set();
    allResults = allResults.filter((r) => {
      if (!r.text) return false;
      if (seen.has(r.text)) return false;
      seen.add(r.text);
      return true;
    });

    // -----------------------------------
    // 4. Global ranking
    // -----------------------------------
    allResults.sort((a, b) => b.norm_score - a.norm_score);

    const topResults = allResults.slice(0, FINAL_TOP_K);

    // -----------------------------------
    // 5. Build context (LLM-ready)
    // -----------------------------------
    const context = topResults
      .map(
        (r, i) => `
[${i + 1}] Source: ${r.source}
${r.text}
`
      )
      .join("\n");

    return {
      raw: topResults,
      context,
    };

  } catch (err: any) {
    console.error(
      "VECTOR ERROR FULL:",
      JSON.stringify(err.response?.data, null, 2)
    );
    throw err;
  }
}