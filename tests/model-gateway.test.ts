import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_BODY_LIMIT, proxyModelRequest } from "../lib/server/model-gateway.ts";

const chat = "v3/ai/language-model";
const request = (body: unknown, headers: Record<string, string> = {}) => new Request(`https://console.example/api/model-gateway/${chat}`, {
  method: "POST", headers: { authorization: "Bearer scoped-task", ...headers }, body: JSON.stringify(body),
});

test("model proxy replaces credentials, locks the model, and streams provider output", async () => {
  let consumed = false;
  const response = await proxyModelRequest(request({ model: "expensive/model", maxOutputTokens: 999999,
    providerOptions: { gateway: { models: ["expensive/fallback"] }, anthropic: { thinking: "auto" } }, prompt: [],
  }, { authorization: "Bearer scoped-task", "ai-language-model-id": "expensive/model", "x-vercel-ai-gateway-team": "foreign-team" }), chat, {
    authorize: async (token, consume) => { assert.equal(token, "scoped-task"); consumed = consume; return { model: "zai/glm-5.3-flash" }; },
    apiKey: () => "server-key",
    fetch: async (url, options) => {
      assert.equal(url, "https://ai-gateway.vercel.sh/v3/ai/language-model");
      const headers = new Headers(options?.headers);
      assert.equal(headers.get("authorization"), "Bearer server-key");
      assert.equal(headers.get("ai-language-model-id"), "zai/glm-5.3-flash");
      assert.equal(headers.get("x-vercel-ai-gateway-team"), null);
      const body = JSON.parse(options?.body as string);
      assert.equal(body.model, undefined);
      assert.equal(body.providerOptions.gateway, undefined);
      assert.equal(body.maxOutputTokens, 32768);
      assert.equal(options?.redirect, "error");
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: token\n\n")); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  assert.equal(consumed, true);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(await response.text(), "data: token\n\n");
});

test("proxy refuses inactive tasks, foreign paths, and oversized model bodies", async () => {
  const deps = { authorize: async () => undefined, apiKey: () => { throw new Error("must not read key"); } };
  assert.equal((await proxyModelRequest(request({}), chat, deps)).status, 403);
  assert.equal((await proxyModelRequest(request({}), "v1/generation", deps)).status, 404);
  assert.equal((await proxyModelRequest(request({ prompt: "x".repeat(MODEL_BODY_LIMIT) }), chat, {
    ...deps, authorize: async () => ({ model: "zai/glm-5.3-flash" }),
  })).status, 400);
});

test("catalog validates scope without spending a model request and strips upstream errors", async () => {
  const response = await proxyModelRequest(new Request("https://console.example/catalog", { headers: { Authorization: "Bearer scoped-task" } }), "coding-agent/v1/models", {
    authorize: async (_, consume) => { assert.equal(consume, false); return { model: "zai/glm-5.3-flash" }; },
    apiKey: () => "server-key",
    fetch: async () => new Response("private diagnostic", { status: 429 }),
  });
  assert.equal(response.status, 429);
  assert.doesNotMatch(await response.text(), /private diagnostic/);
});
