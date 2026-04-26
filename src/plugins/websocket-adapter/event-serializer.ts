import type { OutgoingMessage } from '../../core/types.js';
import { generateEventId } from '../sse-adapter/event-serializer.js';

export interface WSEventEnvelope {
  event: string;
  id?: string;
  data: unknown;
  timestamp: string;
}

export function serializeWSEvent(event: string, data: unknown, id = generateEventId()): string {
  const payload: WSEventEnvelope = {
    event,
    id,
    data,
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify(payload);
}

export function serializeOutgoingMessage(sessionId: string, message: OutgoingMessage): string {
  return serializeWSEvent('message', {
    type: message.type,
    sessionId,
    text: message.text,
    metadata: message.metadata,
  });
}

export function serializePermissionRequest(
  sessionId: string,
  request: { id: string; description: string; options: Array<{ id: string; label: string; isAllow: boolean }> },
): string {
  return serializeWSEvent('permission_request', { sessionId, ...request });
}

