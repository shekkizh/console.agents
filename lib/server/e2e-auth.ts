import { config, requireE2ETestIdentity } from "@/lib/server/config";

export function authorizedE2ETestRequest(request: Request): boolean {
  if (!config.e2eTestMode) return false;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  return Boolean(bearer && bearer === requireE2ETestIdentity().token);
}
