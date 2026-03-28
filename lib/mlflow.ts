import axios, { AxiosError } from "axios";
import { Agent as HttpsAgent } from "https";

const HOST = process.env.DATABRICKS_HOST;
const TOKEN = process.env.DATABRICKS_TOKEN;
const EXPERIMENT_ID = process.env.DATABRICKS_MLFLOW_EXPERIMENT_ID;

const isConfigured = Boolean(HOST && TOKEN && EXPERIMENT_ID);
let mlflowDisabled = false;
let mlflowDisableReason: string | null = null;

const httpsAgent = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
});

const mlflowHttp = axios.create({
  baseURL: HOST,
  timeout: 10_000,
  httpsAgent,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
});

function isMlflowAvailable() {
  return isConfigured && !mlflowDisabled;
}

function getAxiosMessage(err: unknown) {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const detail = typeof err.response?.data === "string"
      ? err.response.data
      : JSON.stringify(err.response?.data ?? {});

    return status ? `status ${status}: ${detail}` : err.message;
  }

  return err instanceof Error ? err.message : String(err);
}

function maybeDisableMlflow(err: unknown) {
  if (!axios.isAxiosError(err)) return;

  const status = err.response?.status;
  if (status && status >= 400 && status < 500) {
    mlflowDisabled = true;
    mlflowDisableReason = getAxiosMessage(err);
    console.warn("MLflow disabled for this process due to client/configuration error:", mlflowDisableReason);
  }
}

function logMlflowError(prefix: string, err: unknown) {
  console.warn(prefix, getAxiosMessage(err));
  maybeDisableMlflow(err);
}

export async function startMlflowRun(tags?: Record<string, string>) {
  if (!isMlflowAvailable()) return null;

  try {
    const res = await mlflowHttp.post("/api/2.0/mlflow/runs/create", {
      experiment_id: EXPERIMENT_ID,
      start_time: Date.now(),
      tags: Object.entries(tags ?? {}).map(([key, value]) => ({ key, value })),
    });

    return res.data?.run?.info?.run_id ?? null;
  } catch (err) {
    logMlflowError("MLflow start run failed", err);
    return null;
  }
}

export async function logMlflowParams(runId: string | null, params: Record<string, string>) {
  if (!runId || !isMlflowAvailable()) return;

  try {
    await mlflowHttp.post("/api/2.0/mlflow/runs/log-batch", {
      run_id: runId,
      params: Object.entries(params).map(([key, value]) => ({ key, value })),
    });
  } catch (err) {
    logMlflowError("MLflow log params failed", err);
  }
}

export async function logMlflowTags(runId: string | null, tags: Record<string, string>) {
  if (!runId || !isMlflowAvailable()) return;

  try {
    await Promise.all(
      Object.entries(tags).map(([key, value]) =>
        mlflowHttp.post("/api/2.0/mlflow/runs/set-tag", {
          run_id: runId,
          key,
          value,
        })
      )
    );
  } catch (err) {
    logMlflowError("MLflow log tags failed", err);
  }
}

export async function logMlflowMetrics(runId: string | null, metrics: Record<string, number>) {
  if (!runId || !isMlflowAvailable()) return;

  const timestamp = Date.now();

  try {
    await mlflowHttp.post("/api/2.0/mlflow/runs/log-batch", {
      run_id: runId,
      metrics: Object.entries(metrics)
        .filter(([, value]) => Number.isFinite(value))
        .map(([key, value]) => ({
          key,
          value,
          timestamp,
          step: 0,
        })),
    });
  } catch (err) {
    logMlflowError("MLflow log metrics failed", err);
  }
}

export async function endMlflowRun(runId: string | null, status: "FINISHED" | "FAILED" = "FINISHED") {
  if (!runId || !isMlflowAvailable()) return;

  try {
    await mlflowHttp.post("/api/2.0/mlflow/runs/update", {
      run_id: runId,
      status,
      end_time: Date.now(),
    });
  } catch (err) {
    logMlflowError("MLflow end run failed", err);
  }
}
