import { defineSandbox } from "eve/sandbox";
import { microsandbox } from "eve/sandbox/microsandbox";
import { vercel } from "eve/sandbox/vercel";
import { activeFxNetworkPolicy, idleFxNetworkPolicy } from "@/lib/server/fx-network-policy";
import { config } from "@/lib/server/config";
import { fxInstallCommand } from "@/lib/server/fx-runtime";

export default defineSandbox({
  backend: process.env.VERCEL
    ? vercel({ networkPolicy: idleFxNetworkPolicy() })
    : microsandbox({ networkPolicy: activeFxNetworkPolicy() }),
  revalidationKey: () => `fx-${config.fxVersion}`,
  async bootstrap({ use: acquireSandbox }) {
    const sandbox = await acquireSandbox();
    const install = await sandbox.run({ command: fxInstallCommand() });
    if (install.exitCode !== 0) {
      throw new Error(`Agent runtime bootstrap failed: ${install.stderr.slice(0, 500)}`);
    }
  },
});
