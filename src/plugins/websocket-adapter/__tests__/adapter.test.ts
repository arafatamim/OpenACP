import { describe, it, expect, vi } from 'vitest';
import { WebSocketAdapter } from '../adapter.js';
import type { WSConnectionManager } from '../connection-manager.js';

function createMockConnectionManager(): WSConnectionManager {
  return {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getConnectionsBySession: vi.fn().mockReturnValue([]),
    broadcast: vi.fn(),
    disconnectByToken: vi.fn(),
    listConnections: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as WSConnectionManager;
}

describe('WebSocketAdapter', () => {
  it('broadcasts outgoing messages in websocket envelope format', async () => {
    const connectionManager = createMockConnectionManager();
    const adapter = new WebSocketAdapter(connectionManager);

    await adapter.sendMessage('sess-1', { type: 'text', text: 'hello' });

    expect(connectionManager.broadcast).toHaveBeenCalledOnce();
    expect(connectionManager.broadcast).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('"event":"message"'),
    );
  });

  it('broadcasts permission requests', async () => {
    const connectionManager = createMockConnectionManager();
    const adapter = new WebSocketAdapter(connectionManager);

    await adapter.sendPermissionRequest('sess-1', {
      id: 'perm-1',
      description: 'Allow?',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    });

    expect(connectionManager.broadcast).toHaveBeenCalledWith(
      'sess-1',
      expect.stringContaining('"event":"permission_request"'),
    );
  });

  it('cleans up connections on stop', async () => {
    const connectionManager = createMockConnectionManager();
    const adapter = new WebSocketAdapter(connectionManager);
    await adapter.stop();
    expect(connectionManager.cleanup).toHaveBeenCalledOnce();
  });
});

