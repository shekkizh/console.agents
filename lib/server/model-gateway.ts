/** The sandbox receives a task token, never the account-wide Gateway key. */
export const MODEL_REQUEST_LIMIT = 500;
export const MODEL_BODY_LIMIT = 4 * 1024 * 1024;
const CHAT_PATH = "v3/ai/language-model";
const CATALOG_PATH = "coding-agent/v1/models";

export interface ModelGatewayDependencies {
  authorize: (token: string, consumeRequest: boolean) => Promise<{ model: string } | undefined>;
  apiKey: () => string;
  fetch?: typeof fetch;
}

async function limitedJson(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_BODY_LIMIT) throw new Error("Model request exceeds 4 MB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid model request");
  return body;
}

export async function proxyModelRequest(request: Request, path: string, dependencies: ModelGatewayDependencies): Promise<Response> {
  const isChat = path === CHAT_PATH && request.method === "POST";
  if (!isChat && !(path === CATALOG_PATH && request.method === "GET")) {
    return Response.json({ error: "Unsupported model Gateway operation" }, { status: 404 });
  }
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const scope = await dependencies.authorize(token, isChat);
  if (!scope) return Response.json({ error: "Task inactive, unauthorized, or model request budget exhausted" }, { status: 403 });
  let body: string | undefined;
  if (isChat) {
    try {
      const value = await limitedJson(request);
      // Gateway fallback models and BYOK options cannot override the agent model.
      delete value.model;
      if (value.providerOptions && typeof value.providerOptions === "object" && !Array.isArray(value.providerOptions)) {
        delete (value.providerOptions as Record<string, unknown>).gateway;
      }
      value.maxOutputTokens = typeof value.maxOutputTokens === "number" && value.maxOutputTokens > 0
        ? Math.min(Math.floor(value.maxOutputTokens), 32768) : 32768;
      body = JSON.stringify(value);
    } catch {
      return Response.json({ error: "Invalid or oversized model request" }, { status: 400 });
    }
  }
  const headers = new Headers({ Authorization: `Bearer ${dependencies.apiKey()}` });
  if (isChat) {
    headers.set("Content-Type", "application/json");
    headers.set("ai-gateway-protocol-version", "0.0.1");
    headers.set("ai-language-model-specification-version", "4");
    headers.set("ai-language-model-id", scope.model);
    headers.set("ai-language-model-streaming", request.headers.get("ai-language-model-streaming") === "false" ? "false" : "true");
  }
  try {
    const upstream = await (dependencies.fetch ?? fetch)(`https://ai-gateway.vercel.sh/${path}`, {
      method: request.method, headers, body, signal: request.signal, redirect: "error", cache: "no-store",
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return Response.json({ error: "The model provider rejected the request", status: upstream.status }, { status: upstream.status });
    }
    // Returning the stream preserves tokens arriving before the request finishes.
    return new Response(upstream.body, { status: upstream.status, headers: {
      "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      "Cache-Control": "no-store", "X-Accel-Buffering": "no",
    } });
  } catch {
    return Response.json({ error: "The model provider connection was interrupted" }, { status: 502 });
  }
}
