"use client";

export default function Message({ content, role, table, mode, reason, onAction }: any) {
  let parsed: any = null;
  let cleanContent = content;

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
    <div className={`flex gap-3 ${role === "user" ? "justify-end" : ""}`}>
      {/* Assistant Avatar */}
      {role === "assistant" && (
        <div className="w-7 h-7 sm:w-8 sm:h-8 shrink-0 rounded-full bg-gradient-to-r from-indigo-500 to-purple-600 flex items-center justify-center text-xs sm:text-sm font-bold">
          AI
        </div>
      )}

      {/* Message Bubble */}
      <div
        className={`max-w-[85vw] sm:max-w-[72ch] px-3 sm:px-4 py-2.5 sm:py-3 rounded-2xl shadow-lg ${
          role === "user"
            ? "bg-gradient-to-r from-indigo-500 to-purple-600 text-white"
            : "bg-white/10 backdrop-blur-md text-white border border-white/10"
        }`}
      >
        {role === "assistant" && (
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] sm:text-xs">
            <span
              className={`rounded-full px-2 py-0.5 font-semibold ${
                mode === "SQL"
                  ? "bg-sky-500/20 text-sky-200 border border-sky-400/30"
                  : mode === "RAG"
                    ? "bg-amber-500/20 text-amber-200 border border-amber-400/30"
                    : "bg-zinc-500/20 text-zinc-200 border border-zinc-400/30"
              }`}
            >
              {mode || "ASSISTANT"}
            </span>
            {reason && <span className="text-zinc-300">{reason}</span>}
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
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-md border border-white/20 px-2 py-1 text-[11px] sm:text-xs hover:bg-white/10"
              onClick={() => onAction?.("regenerate")}
            >
              Regenerate
            </button>
            <button
              type="button"
              className="rounded-md border border-white/20 px-2 py-1 text-[11px] sm:text-xs hover:bg-white/10"
              onClick={() => onAction?.("explain")}
            >
              Explain
            </button>
            <button
              type="button"
              className="rounded-md border border-white/20 px-2 py-1 text-[11px] sm:text-xs hover:bg-white/10"
              onClick={() => onAction?.("continue")}
            >
              Continue
            </button>
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
      <div className="mb-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copyCSV}
          className="rounded-md border border-white/20 px-2 py-1 text-[11px] sm:text-xs hover:bg-white/10"
        >
          Copy CSV
        </button>
        <button
          type="button"
          onClick={downloadCSV}
          className="rounded-md border border-white/20 px-2 py-1 text-[11px] sm:text-xs hover:bg-white/10"
        >
          Download CSV
        </button>
      </div>

      <div className="sm:hidden space-y-2">
        {data.map((row: any, i: number) => (
          <details key={i} className="rounded-lg border border-white/10 bg-white/5 p-2">
            <summary className="cursor-pointer text-xs text-zinc-200">Row {i + 1}</summary>
            <div className="mt-2 space-y-1">
              {cols.map((c) => (
                <div key={c} className="text-xs">
                  <span className="text-zinc-400">{c}: </span>
                  <span className="text-zinc-100 break-words">{String(row[c] ?? "")}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>

      <div className="hidden sm:block overflow-x-auto -mx-1 sm:mx-0">
        <table className="min-w-full text-xs sm:text-sm border border-white/10 rounded-lg overflow-hidden">
          <thead className="bg-white/10 sticky top-0">
            <tr>
              {cols.map((c) => (
                <th key={c} className="px-2 sm:px-3 py-2 text-left whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row: any, i: number) => (
              <tr key={i} className="hover:bg-white/5 transition">
                {cols.map((c) => (
                  <td key={c} className="px-2 sm:px-3 py-2 align-top break-words whitespace-normal">
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
  return (
    <div className="whitespace-pre-wrap break-words space-y-2 leading-relaxed text-sm sm:text-base">
      {text.split("\n").map((line: string, i: number) => {
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
