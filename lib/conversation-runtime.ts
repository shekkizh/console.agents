export const CONVERSATION_RUNTIME_VERSION = 2;

export function visibleConversationSessionId(
  runtimeVersion: number,
  eveSessionId: string | null,
): string | null {
  return runtimeVersion === CONVERSATION_RUNTIME_VERSION ? eveSessionId : null;
}
