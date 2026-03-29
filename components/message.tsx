"use client";

import { useState } from "react";

export default function Message({ content, role, table, mode, reason, onAction, messageId, sessionId, userMessage, timestamp }: any) {
  const [feedback, setFeedback] = useState<"like" | "dislike" | null>(null);
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleRating = (rating: "like" | "dislike") => {
    if (submitted) return;
    setFeedback(rating);
    setShowCommentBox(true);
  };

  const submitFeedback = async (ratingOverride?: "like" | "dislike") => {
    const rating = ratingOverride ?? feedback;
    if (!rating || submitting) return;
    setSubmitting(true);
    try {
      await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId,
          sessionId,
          rating,
          comment: comment.trim() || null,
          assistantMessage: typeof content === "string" ? content : "",
          userMessage: userMessage ?? "",
        }),
      });
      setSubmitted(true);
      setShowCommentBox(false);
    } catch {
      // fail silently
    } finally {
      setSubmitting(false);
    }
  };

  const copyAssistantResponse = async () => {
    if (role !== "assistant") return;
    const text = typeof content === "string" ? content.replace(/\n__FOLLOWUPS__[\s\S]*/m, "") : JSON.stringify(content);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  let parsed: any = null;
  let cleanContent = typeof content === "string" ? content : "";

  if (typeof content === "string" && content.includes("__FOLLOWUPS__")) {
    const [main] = content.split("__FOLLOWUPS__");
    cleanContent = main.trim();

    try {
      parsed = JSON.parse(main);
    } catch {
      parsed = null;
    }
  } else {
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }
  }

  return (
    <div className={`flex gap-3 message-in ${role === "user" ? "justify-end" : ""}`}>
      {/* Assistant Avatar */}
      {role === "assistant" && (
        <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 flex items-center justify-center text-xs sm:text-sm font-bold">
          AI
        </div>
      )}

      {/* Message Bubble */}
      <div className={`flex flex-col gap-0.5 min-w-0 ${role === "user" ? "items-end" : ""}`}>
      <div
        className={`max-w-[85vw] sm:max-w-[72ch] px-3 sm:px-4 py-2.5 sm:py-3 rounded-2xl shadow-lg transition-transform duration-200 ${
          role === "user"
            ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white hover:-translate-y-0.5"
            : "bg-white/10 backdrop-blur-md text-white border border-white/10 hover:-translate-y-0.5"
        }`}
      >
        {role === "assistant" && (
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] sm:text-xs">
            <span
              className={`rounded-full px-3 py-1 font-semibold inline-flex items-center gap-1 ${
                mode === "SQL"
                  ? "bg-sky-500/20 text-sky-200 border border-sky-400/40 shadow-sm shadow-sky-500/20"
                  : mode === "RAG"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-400/40 shadow-sm shadow-amber-500/20"
                    : "bg-zinc-500/20 text-zinc-200 border border-zinc-400/40"
              }`}
            >
              <span>{mode === "SQL" ? "🔍" : mode === "RAG" ? "📚" : "⚙️"}</span>
              {mode || "ASSISTANT"}
            </span>
            {reason && <span className="text-zinc-400">{reason}</span>}
          </div>
        )}

        {table ? (
          <>
            <FormattedText text={cleanContent} />
            <div className="mt-4">
              <Table data={table} />
            </div>
          </>
        ) : parsed?.type === "table" ? (
          <Table data={parsed.data} />
        ) : (
          <FormattedText text={cleanContent} />
        )}

        {role === "assistant" && (
          <div className="mt-4 pt-3 border-t border-white/10 space-y-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs sm:text-sm hover:bg-white/10 transition hover:border-white/30 group flex items-center gap-1"
                onClick={() => onAction?.("regenerate")}
              >
                <span className="text-base">↻</span> Regenerate
              </button>
              <button
                type="button"
                className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs sm:text-sm hover:bg-white/10 transition hover:border-white/30 group flex items-center gap-1"
                onClick={() => onAction?.("explain")}
              >
                <span className="text-base">💡</span> Explain
              </button>
              <button
                type="button"
                className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs sm:text-sm hover:bg-white/10 transition hover:border-white/30 group flex items-center gap-1"
                onClick={() => onAction?.("continue")}
              >
                <span className="text-base">→</span> Continue
              </button>
              <button
                type="button"
                className="rounded-md border border-white/20 px-2.5 py-1.5 text-xs sm:text-sm hover:bg-white/10 transition hover:border-white/30 group flex items-center gap-1"
                onClick={copyAssistantResponse}
              >
                <span className="text-base">📋</span> {copied ? "Copied" : "Copy"}
              </button>

              {/* Feedback buttons */}
              {!submitted ? (
                <>
                  <button
                    type="button"
                    aria-label="Like"
                    onClick={() => handleRating("like")}
                    className={`rounded-md border px-2.5 py-1.5 text-sm transition flex items-center gap-1 ${
                      feedback === "like"
                        ? "border-green-400/60 bg-green-500/20 text-green-300"
                        : "border-white/20 hover:bg-white/10"
                    }`}
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    aria-label="Dislike"
                    onClick={() => handleRating("dislike")}
                    className={`rounded-md border px-2.5 py-1.5 text-sm transition flex items-center gap-1 ${
                      feedback === "dislike"
                        ? "border-red-400/60 bg-red-500/20 text-red-300"
                        : "border-white/20 hover:bg-white/10"
                    }`}
                  >
                    👎
                  </button>
                </>
              ) : (
                <span className="text-xs sm:text-sm text-emerald-400 self-center font-medium">✓ Feedback recorded</span>
              )}
            </div>

            {/* Optional comment box */}
            {showCommentBox && !submitted && (
              <div className="flex flex-col gap-2 mt-2 pt-3 border-t border-white/10">
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment (optional)…"
                  rows={2}
                  className="w-full rounded-lg bg-white/10 border border-white/20 px-3 py-2 text-xs text-white placeholder:text-zinc-400 outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => submitFeedback()}
                    className="rounded-md bg-indigo-500/80 hover:bg-indigo-500 px-3 py-1.5 text-xs font-medium disabled:opacity-50 transition"
                  >
                    {submitting ? "Submitting…" : "Submit"}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowCommentBox(false); submitFeedback(); }}
                    className="rounded-md border border-white/20 px-3 py-1.5 text-xs hover:bg-white/10 transition"
                  >
                    Skip
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {timestamp && (
        <div className="text-[10px] text-zinc-500 px-1">
          {formatRelativeTime(timestamp)}
        </div>
      )}
      </div>

      {/* User Avatar */}
      {role === "user" && (
        <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-full bg-white text-black flex items-center justify-center text-xs sm:text-sm font-bold">
          U
        </div>
      )}
    </div>
  );
}

// ================= TABLE =================

function Table({ data }: any) {
  if (!data?.length) return <p>No data</p>;

  const cols = Object.keys(data[0]);

  const toCSV = () => {
    const head = cols.join(",");
    const rows = data.map((row: any) => cols.map((col) => JSON.stringify(row[col] ?? "")).join(","));
    return [head, ...rows].join("\n");
  };

  const copyCSV = async () => {
    await navigator.clipboard.writeText(toCSV());
  };

  const downloadCSV = () => {
    const blob = new Blob([toCSV()], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "results.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-200 border border-indigo-400/30 shadow-sm shadow-indigo-500/10">
          {data.length} row{data.length !== 1 ? "s" : ""}
        </span>
        <button
          type="button"
          onClick={copyCSV}
          className="rounded-md border border-white/20 px-2.5 py-1 text-xs hover:bg-white/10 transition"
        >
          📋 Copy CSV
        </button>
        <button
          type="button"
          onClick={downloadCSV}
          className="rounded-md border border-white/20 px-2.5 py-1 text-xs hover:bg-white/10 transition"
        >
          ⬇️ Download CSV
        </button>
      </div>

      <div className="sm:hidden space-y-2">
        {data.map((row: any, i: number) => (
          <details key={i} className="rounded-lg border border-white/10 bg-white/5 p-3 cursor-pointer group hover:bg-white/10 transition">
            <summary className="cursor-pointer text-xs font-semibold text-zinc-200 group-hover:text-white transition">
              <span className="inline-block mr-2">▶</span>Row {i + 1}
            </summary>
            <div className="mt-3 space-y-2 pl-4 border-l border-white/10">
              {cols.map((c) => (
                <div key={c} className="text-xs flex justify-between">
                  <span className="text-zinc-400 font-semibold">{c}</span>
                  <span className="text-zinc-100 break-words text-right max-w-[200px]">{String(row[c] ?? "")}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>

      <div className="hidden sm:block overflow-x-auto -mx-1 sm:mx-0">
        <table className="min-w-full text-xs sm:text-sm border border-white/10 rounded-lg overflow-hidden">
          <thead className="bg-white/10 sticky top-0 border-b border-white/10">
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-3 sm:px-4 py-3 text-left whitespace-nowrap font-semibold text-zinc-200">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row: any, i: number) => (
              <tr key={i} className="hover:bg-white/8 transition border-b border-white/5 last:border-0">
                {cols.map((c) => (
                  <td key={c} className="px-3 sm:px-4 py-3 align-top break-words whitespace-normal text-zinc-100">
                    {row[c]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ================= TEXT =================

function FormattedText({ text }: any) {
  const safeText = typeof text === "string" ? text : "";
  return (
    <div className="whitespace-pre-wrap break-words space-y-2 leading-relaxed text-sm sm:text-base">
      {safeText.split("\n").map((line: string, i: number) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("### ")) {
          return (
            <div key={i} className="text-lg font-semibold text-indigo-300 mt-2">
              {trimmed.replace("### ", "")}
            </div>
          );
        }

        if (trimmed.startsWith("## ")) {
          return (
            <div key={i} className="text-xl font-semibold text-indigo-200 mt-3">
              {trimmed.replace("## ", "")}
            </div>
          );
        }

        if (trimmed.startsWith("# ")) {
          return (
            <div key={i} className="text-2xl font-bold text-white mt-4">
              {trimmed.replace("# ", "")}
            </div>
          );
        }

        if (trimmed.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2">
              <span>•</span>
              <span>{formatInline(trimmed.slice(2))}</span>
            </div>
          );
        }

        return <div key={i}>{formatInline(line)}</div>;
      })}
    </div>
  );
}

function formatRelativeTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function formatInline(text: string) {
  const parts = text.split(/(\*\*.*?\*\*)/g);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <span key={i} className="font-semibold text-indigo-300">
          {part.slice(2, -2)}
        </span>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
