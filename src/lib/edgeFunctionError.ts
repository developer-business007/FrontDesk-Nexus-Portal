import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";

type EdgeFnPayload = Record<string, unknown>;

async function readEdgeFunctionErrorPayload(
  error: FunctionsHttpError,
): Promise<EdgeFnPayload | null> {
  const response = error.context as Response | undefined;
  if (!response) return null;
  try {
    const body = await response.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as EdgeFnPayload;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function resolveEdgeFunctionError(
  error: Error,
  data: unknown,
): Promise<string> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const row = data as EdgeFnPayload;
    if (typeof row.error === "string" && row.error.trim()) return row.error;
    if (typeof row.message === "string" && row.message.trim()) return row.message;
  }

  if (error instanceof FunctionsHttpError) {
    const body = await readEdgeFunctionErrorPayload(error);
    if (typeof body?.error === "string" && body.error.trim()) return body.error;
    if (typeof body?.message === "string" && body.message.trim()) return body.message;
  }

  if (error instanceof FunctionsFetchError || error.message.includes("Failed to send")) {
    return "Edge function not reachable. Check deployment and network.";
  }

  return error.message || "Request failed";
}
