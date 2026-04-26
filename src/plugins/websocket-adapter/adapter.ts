import type { IChannelAdapter, AdapterCapabilities } from '../../core/channel.js';
import type { NotificationMessage, OutgoingMessage, PermissionRequest } from '../../core/types.js';
import { serializeOutgoingMessage, serializePermissionRequest, serializeWSEvent } from './event-serializer.js';
import type { WSConnectionManager } from './connection-manager.js';

export class WebSocketAdapter implements IChannelAdapter {
  readonly name = 'websocket';
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    richFormatting: false,
    threads: true,
    reactions: false,
    fileUpload: false,
    voice: false,
  };

  constructor(private readonly connectionManager: WSConnectionManager) {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.connectionManager.cleanup();
  }

  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    this.connectionManager.broadcast(sessionId, serializeOutgoingMessage(sessionId, content));
  }

  async sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    this.connectionManager.broadcast(sessionId, serializePermissionRequest(sessionId, request));
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    if (!notification.sessionId) return;
    this.connectionManager.broadcast(notification.sessionId, serializeWSEvent('notification', notification));
  }

  async createSessionThread(sessionId: string, _name: string): Promise<string> {
    return sessionId;
  }

  async renameSessionThread(_sessionId: string, _newName: string): Promise<void> {}
}

