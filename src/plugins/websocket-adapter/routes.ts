import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OpenACPCore } from '../../core/core.js';
import type { WSConnectionManager } from './connection-manager.js';
import type { CommandRegistry } from '../../core/command-registry.js';
import { requireScopes } from '../api-server/middleware/auth.js';
import { resolveAttachments } from '../api-server/routes/attachment-utils.js';
import { ServiceUnavailableError } from '../api-server/middleware/error-handler.js';
import { SessionIdParamSchema } from '../api-server/schemas/sessions.js';
import { serializeWSEvent } from './event-serializer.js';

const PromptPayloadSchema = z.object({
  action: z.literal('prompt'),
  prompt: z.string().min(1),
  attachments: z.array(z.object({
    fileName: z.string(),
    mimeType: z.string(),
    data: z.string(),
  })).optional(),
});

const PermissionPayloadSchema = z.object({
  action: z.literal('permission'),
  permissionId: z.string().min(1),
  optionId: z.string().min(1),
  feedback: z.string().optional(),
});

const CancelPayloadSchema = z.object({
  action: z.literal('cancel'),
});

const CommandPayloadSchema = z.object({
  action: z.literal('command'),
  command: z.string().min(1),
});

const PingPayloadSchema = z.object({
  action: z.literal('ping'),
});

const IncomingPayloadSchema = z.union([
  PromptPayloadSchema,
  PermissionPayloadSchema,
  CancelPayloadSchema,
  CommandPayloadSchema,
  PingPayloadSchema,
]);

export interface WebSocketRouteDeps {
  core: OpenACPCore;
  connectionManager: WSConnectionManager;
  commandRegistry?: CommandRegistry;
}

function decodeParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function websocketRoutes(app: FastifyInstance, deps: WebSocketRouteDeps): Promise<void> {
  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/ws',
    ({ websocket: true, preHandler: requireScopes('sessions:read') } as any),
    (async (socket: any, request: any) => {
      const { sessionId: rawId } = SessionIdParamSchema.parse(request.params);
      const sessionId = decodeParam(rawId);
      const session = deps.core.sessionManager.getSession(sessionId);

      if (!session) {
        socket.socket.send(serializeWSEvent('error', { code: 'SESSION_NOT_FOUND', sessionId }));
        socket.socket.close(1008, 'Session not found');
        return;
      }

      const tokenId = (request as any).auth?.tokenId ?? 'anonymous';
      let connectionId: string;
      try {
        connectionId = deps.connectionManager.addConnection(sessionId, tokenId, socket.socket as any).id;
      } catch (err) {
        socket.socket.send(serializeWSEvent('error', { code: 'CONNECTION_LIMIT', message: (err as Error).message }));
        socket.socket.close(1013, 'Connection limit reached');
        return;
      }

      socket.socket.send(serializeWSEvent('connected', { connectionId, sessionId }));

      socket.socket.on('message', async (raw: unknown) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
        const parsedJson = (() => {
          try { return JSON.parse(text); } catch { return null; }
        })();

        const parsed = IncomingPayloadSchema.safeParse(parsedJson);
        if (!parsed.success) {
          socket.socket.send(serializeWSEvent('error', { code: 'INVALID_MESSAGE' }));
          return;
        }

        const payload = parsed.data;
        const activeSession = deps.core.sessionManager.getSession(sessionId);
        if (!activeSession) {
          socket.socket.send(serializeWSEvent('error', { code: 'SESSION_NOT_FOUND', sessionId }));
          return;
        }

        if (payload.action === 'ping') {
          socket.socket.send(serializeWSEvent('pong', { sessionId }));
          return;
        }

        if (payload.action === 'prompt') {
          let attachments;
          if (payload.attachments?.length) {
            let fileService;
            try {
              fileService = deps.core.fileService;
            } catch {
              throw new ServiceUnavailableError(
                'FILE_SERVICE_UNAVAILABLE',
                'File attachments are not supported: file-service plugin is not loaded',
              );
            }
            attachments = await resolveAttachments(fileService, sessionId, payload.attachments);
          }

          const userId = (request as any).auth?.tokenId ?? 'api';
          const result = await deps.core.handleMessageInSession(
            activeSession,
            { channelId: 'api', userId, text: payload.prompt, attachments },
            { channelUser: { channelId: 'api', userId } },
            { responseAdapterId: 'websocket' },
          );
          socket.socket.send(serializeWSEvent('ack', { action: 'prompt', ...result }));
          return;
        }

        if (payload.action === 'permission') {
          if (!activeSession.permissionGate.isPending || activeSession.permissionGate.requestId !== payload.permissionId) {
            socket.socket.send(serializeWSEvent('error', { code: 'NO_PENDING_PERMISSION' }));
            return;
          }

          activeSession.permissionGate.resolve(payload.optionId);

          if (payload.feedback) {
            await activeSession.abortPrompt().catch(() => {});
            await activeSession.enqueuePrompt(payload.feedback, undefined, { sourceAdapterId: 'websocket' });
          }

          socket.socket.send(serializeWSEvent('ack', { action: 'permission', ok: true }));
          return;
        }

        if (payload.action === 'cancel') {
          await activeSession.abortPrompt();
          socket.socket.send(serializeWSEvent('ack', { action: 'cancel', ok: true }));
          return;
        }

        if (payload.action === 'command') {
          if (!deps.commandRegistry) {
            socket.socket.send(serializeWSEvent('error', { code: 'COMMAND_REGISTRY_UNAVAILABLE' }));
            return;
          }

          const commandString = payload.command.startsWith('/') ? payload.command : `/${payload.command}`;
          const result = await deps.commandRegistry.execute(commandString, {
            raw: '',
            sessionId,
            channelId: 'api',
            userId: (request as any).auth?.tokenId ?? 'api',
            reply: async () => {},
          });
          socket.socket.send(serializeWSEvent('ack', { action: 'command', result }));
        }
      });
    }) as any,
  );

  app.get('/connections', { preHandler: requireScopes('system:admin') }, async () => {
    const connections = deps.connectionManager.listConnections();
    return {
      connections: connections.map((c) => ({
        id: c.id,
        sessionId: c.sessionId,
        connectedAt: c.connectedAt.toISOString(),
      })),
      total: connections.length,
    };
  });
}
