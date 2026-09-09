import { requireAiGatewayApiKey } from "@/lib/server/config";
import { authorizeModelRequest } from "@/lib/server/model-gateway-auth";
import { proxyModelRequest } from "@/lib/server/model-gateway";

export const maxDuration = 300;
export const runtime = "nodejs";

async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxyModelRequest(request, path.join("/"), {
    authorize: authorizeModelRequest,
    apiKey: requireAiGatewayApiKey,
  });
}

export const GET = handle;
export const POST = handle;
