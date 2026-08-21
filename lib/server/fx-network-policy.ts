import type { SandboxNetworkPolicy } from "eve/sandbox";

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

const developmentAllow = {
  ...installAllow,
  "github.com": [],
  "*.github.com": [],
  "*.githubusercontent.com": [],
  "registry.npmjs.org": [],
  "*.npmjs.org": [],
  "pypi.org": [],
  "files.pythonhosted.org": [],
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

export function activeFxNetworkPolicy(): SandboxNetworkPolicy {
  return {
    allow: {
      ...developmentAllow,
      [AI_GATEWAY_HOST]: [],
    },
    subnets: { deny: deniedSubnets },
  };
}

export function usesStaticFxNetworkPolicy(vercelEnvironment = process.env.VERCEL): boolean {
  return !vercelEnvironment;
}
