import { extractBearerToken } from "eve/channels/auth";
import { config, requireE2ETestIdentity } from "@/lib/server/config";

export function authorizedE2ETestRequest(request: Request): boolean {
  if (!config.e2eTestMode) return false;
  const bearer = extractBearerToken(request.headers.get("authorization"));
  return Boolean(bearer && bearer === requireE2ETestIdentity().token);
}
