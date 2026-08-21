import { AgentConsole } from "@/components/agent-console";
import { requireOwner } from "@/lib/server/auth";
import { listAgents } from "@/lib/server/agent-store";
import { createConversation, listConversations } from "@/lib/server/conversation-store";

export default async function Home() {
  const ownerId = await requireOwner();
  const agents = await listAgents(ownerId);
  let conversations = await listConversations(ownerId);
  if (conversations.length === 0 && agents[0]) {
    conversations = [await createConversation(ownerId, agents[0].id)];
  }
  return <AgentConsole initialAgents={agents} initialConversations={conversations} />;
}
