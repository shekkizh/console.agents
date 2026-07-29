import { Workspace } from "@/components/workspace/workspace";
import { requireOwner } from "@/lib/server/auth";
import { getWorkspace } from "@/lib/server/store";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const ownerId = await requireOwner();
  const snapshot = await getWorkspace(ownerId);
  return <Workspace initialSnapshot={snapshot} />;
}
