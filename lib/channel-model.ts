import type { ChannelMessage, ChannelParticipant } from "@/lib/types";

/** Resolve a channel post into concrete recipients without relying on database state. */
export function resolveDeliveryRecipients(
  participants: ChannelParticipant[],
  senderId: string,
  recipientIds?: string[],
): ChannelParticipant[] {
  const members = new Map(participants.map((participant) => [participant.id, participant]));
  if (!members.has(senderId)) throw new Error("Sender is not a member of this channel");

  if (!recipientIds?.length) {
    return participants.filter((participant) => participant.type === "agent" && participant.id !== senderId);
  }

  const ids = [...new Set(recipientIds)];
  if (ids.includes(senderId)) throw new Error("A message cannot be addressed to its sender");
  const recipients = ids.map((id) => members.get(id));
  if (recipients.some((participant) => !participant)) throw new Error("Choose recipients from this channel");
  return recipients as ChannelParticipant[];
}

export function orderChannelMessages<T extends Pick<ChannelMessage, "id" | "createdAt">>(messages: T[]): T[] {
  return [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
