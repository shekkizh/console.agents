import type { SandboxNetworkPolicy } from "eve/sandbox";
import type { FxNetworkAccess } from "@/lib/types";
import { consoleAgentApiHost } from "@/lib/server/config";

const AI_GATEWAY_HOST = "ai-gateway.vercel.sh";

const installAllow = {
  "github.com": [
    {
      match: { method: ["GET", "HEAD"] },
      transform: [],
    },
  ],
  "*.githubusercontent.com": [
    {
      match: { method: ["GET", "HEAD"] },
      transform: [],
    },
  ],
};

const deniedSubnets = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
];

export function idleFxNetworkPolicy(): SandboxNetworkPolicy {
  return {
    allow: installAllow,
    subnets: { deny: deniedSubnets },
  };
}

export function activeFxNetworkPolicy(
  access: FxNetworkAccess = "full",
  allowlist: string[] = [],
  agentApiHost?: string,
): SandboxNetworkPolicy {
  if (access === "full") return "allow-all";
  const messagingHost = agentApiHost ?? consoleAgentApiHost();

  return {
    allow: {
      [AI_GATEWAY_HOST]: [],
      [messagingHost]: [],
      ...(access === "allowlist"
        ? Object.fromEntries(allowlist.map((domain) => [domain, []]))
        : {}),
    },
    subnets: { deny: deniedSubnets },
  };
}

export function stopsFxSandboxAfterTurn(vercelEnvironment = process.env.VERCEL): boolean {
  return !vercelEnvironment;
}
