import { NextRequest, NextResponse } from "next/server";
import { saveFeedback } from "@/lib/databricks";
import { endMlflowRun, logMlflowMetrics, logMlflowParams, startMlflowRun } from "@/lib/mlflow";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let mlflowRunId: string | null = null;

  try {
    const body = await req.json();

    const { messageId, sessionId, rating, comment, assistantMessage, userMessage } = body;

    if (!messageId || !sessionId || !rating) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    if (rating !== "like" && rating !== "dislike") {
      return NextResponse.json({ error: "Invalid rating value" }, { status: 400 });
    }

    mlflowRunId = await startMlflowRun({
      endpoint: "api_feedback",
      message_id: String(messageId),
      session_id: String(sessionId),
      rating: String(rating),
    });

    await logMlflowParams(mlflowRunId, {
      comment_len: String((comment ?? "").length),
      assistant_len: String((assistantMessage ?? "").length),
      user_len: String((userMessage ?? "").length),
    });

    await saveFeedback({
      messageId: String(messageId),
      sessionId: String(sessionId),
      rating,
      comment: comment ? String(comment) : null,
      assistantMessage: String(assistantMessage ?? ""),
      userMessage: String(userMessage ?? ""),
    });

    await logMlflowMetrics(mlflowRunId, {
      feedback_like: rating === "like" ? 1 : 0,
      feedback_dislike: rating === "dislike" ? 1 : 0,
      has_comment: comment ? 1 : 0,
    });
    await endMlflowRun(mlflowRunId, "FINISHED");

    return NextResponse.json({ success: true });
  } catch (err: any) {
    await endMlflowRun(mlflowRunId, "FAILED");
    console.error("Feedback error:", err?.response?.data ?? err);
    return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
  }
}
