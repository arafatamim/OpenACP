import type { OpenACPPlugin } from '../../core/plugin/types.js';
import type { OpenACPCore } from '../../core/core.js';
import type { ApiServerService } from '../api-server/service.js';
import type { CommandRegistry } from '../../core/command-registry.js';
import { BusEvent } from '../../core/events.js';
import { WebSocketAdapter } from './adapter.js';
import { WSConnectionManager } from './connection-manager.js';
import { websocketRoutes } from './routes.js';

let _adapter: WebSocketAdapter | null = null;
let _connectionManager: WSConnectionManager | null = null;

const plugin: OpenACPPlugin = {
  name: '@openacp/websocket-adapter',
  version: '1.0.0',
  description: 'WebSocket transport adapter for app clients',
  pluginDependencies: {
    '@openacp/api-server': '^1.0.0',
    '@openacp/security': '^1.0.0',
    '@openacp/notifications': '^1.0.0',
  },
  permissions: ['services:register', 'services:use', 'kernel:access', 'events:read'],

  async setup(ctx) {
    const core = ctx.core as OpenACPCore;
    const apiServer = ctx.getService<ApiServerService>('api-server');
    if (!apiServer) {
      ctx.log.warn('API server not available, WebSocket adapter disabled');
      return;
    }

    const connectionManager = new WSConnectionManager({ maxPerSession: 10, maxTotal: 100 });
    const adapter = new WebSocketAdapter(connectionManager);
    _adapter = adapter;
    _connectionManager = connectionManager;

    ctx.registerService('adapter:websocket', adapter);
    const commandRegistry = ctx.getService<CommandRegistry>('command-registry');

    ctx.on(BusEvent.SESSION_DELETED, (data: unknown) => {
      const { sessionId } = data as { sessionId: string };
      for (const conn of connectionManager.getConnectionsBySession(sessionId)) {
        try {
          conn.socket.close(1000, 'Session ended');
        } catch {
          // noop
        }
      }
    });

    apiServer.registerPlugin('/api/v1/ws', async (app) => {
      await websocketRoutes(app, { core, connectionManager, commandRegistry: commandRegistry ?? undefined });
    }, { auth: true });

    ctx.log.info('WebSocket adapter registered');
  },

  async teardown() {
    if (_adapter) {
      await _adapter.stop();
      _adapter = null;
    }
    if (_connectionManager) {
      _connectionManager.cleanup();
      _connectionManager = null;
    }
  },
};

export default plugin;

