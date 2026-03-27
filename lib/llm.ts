import axios from "axios";
import { Agent as HttpsAgent } from "https";

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

export async function callLLM(messages: any[]) {
  const res = await openaiHttp.post("/chat/completions", {
    model: "gpt-4o-mini",
    messages,
    temperature: 0,
  });

  return res.data?.choices?.[0]?.message?.content ?? "";
}