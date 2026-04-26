import type { OutgoingMessage } from '../../core/types.js';
export type JsonRpcId = string | number | null;

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
}

export function serializeRpcNotification(method: string, params?: unknown): string {
  const payload: JsonRpcNotification = { jsonrpc: '2.0', method, params };
  return JSON.stringify(payload);
}

export function serializeRpcSuccess(id: JsonRpcId, result: unknown): string {
  const payload: JsonRpcSuccess = { jsonrpc: '2.0', id, result };
  return JSON.stringify(payload);
}

export function serializeRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): string {
  const payload: JsonRpcError = { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
  return JSON.stringify(payload);
}

export function serializeOutgoingMessage(sessionId: string, message: OutgoingMessage): string {
  return serializeRpcNotification('session/update', {
    type: message.type,
    sessionId,
    text: message.text,
    metadata: message.metadata,
    timestamp: new Date().toISOString(),
  });
}

export function serializePermissionRequest(
  sessionId: string,
  request: { id: string; description: string; options: Array<{ id: string; label: string; isAllow: boolean }> },
): string {
  return serializeRpcNotification('session/permission_request', { sessionId, ...request });
}
