import { describe, it, expect } from 'vitest';
import {
  serializeRpcNotification,
  serializeRpcSuccess,
  serializeRpcError,
  serializeOutgoingMessage,
} from '../event-serializer.js';

describe('websocket event serializer (json-rpc)', () => {
  it('serializes notifications as json-rpc 2.0 notifications', () => {
    const raw = serializeRpcNotification('ping');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ jsonrpc: '2.0', method: 'ping' });
    expect(parsed.id).toBeUndefined();
  });

  it('serializes success response with id', () => {
    const parsed = JSON.parse(serializeRpcSuccess(1, { ok: true }));
    expect(parsed).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
  });

  it('serializes error response with code/message', () => {
    const parsed = JSON.parse(serializeRpcError('x', -32601, 'Method not found'));
    expect(parsed).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('maps outgoing messages to session/update notification', () => {
    const parsed = JSON.parse(serializeOutgoingMessage('sess-1', { type: 'text', text: 'hello' }));
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('session/update');
    expect(parsed.params.sessionId).toBe('sess-1');
  });
});

