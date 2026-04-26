import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OpenACPCore } from '../../core/core.js';
import type { WSConnectionManager } from './connection-manager.js';
import type { CommandRegistry } from '../../core/command-registry.js';
import { requireScopes } from '../api-server/middleware/auth.js';
import { resolveAttachments } from '../api-server/routes/attachment-utils.js';
import { ServiceUnavailableError } from '../api-server/middleware/error-handler.js';
import { SessionIdParamSchema } from '../api-server/schemas/sessions.js';
import { serializeRpcError, serializeRpcNotification, serializeRpcSuccess, type JsonRpcId } from './event-serializer.js';

const PromptParamsSchema = z.object({
  prompt: z.string().min(1),
  attachments: z.array(z.object({
    fileName: z.string(),
    mimeType: z.string(),
    data: z.string(),
  })).optional(),
});

const PermissionParamsSchema = z.object({
  permissionId: z.string().min(1),
  optionId: z.string().min(1),
  feedback: z.string().optional(),
});

const CommandParamsSchema = z.object({
  command: z.string().min(1),
});

const RpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
});

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
  async function handlePrompt(sessionId: string, request: any, params: unknown): Promise<unknown> {
    const body = PromptParamsSchema.parse(params ?? {});
    const session = deps.core.sessionManager.getSession(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');

    let attachments;
    if (body.attachments?.length) {
      let fileService;
      try {
        fileService = deps.core.fileService;
      } catch {
        throw new ServiceUnavailableError(
          'FILE_SERVICE_UNAVAILABLE',
          'File attachments are not supported: file-service plugin is not loaded',
        );
      }
      attachments = await resolveAttachments(fileService, sessionId, body.attachments);
    }

    const userId = (request as any).auth?.tokenId ?? 'api';
    return deps.core.handleMessageInSession(
      session,
      { channelId: 'api', userId, text: body.prompt, attachments },
      { channelUser: { channelId: 'api', userId } },
      { responseAdapterId: 'websocket' },
    );
  }

  async function handlePermission(sessionId: string, params: unknown): Promise<{ ok: true }> {
    const body = PermissionParamsSchema.parse(params ?? {});
    const session = deps.core.sessionManager.getSession(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');

    if (!session.permissionGate.isPending || session.permissionGate.requestId !== body.permissionId) {
      throw new Error('NO_PENDING_PERMISSION');
    }
    session.permissionGate.resolve(body.optionId);

    if (body.feedback) {
      await session.abortPrompt().catch(() => {});
      await session.enqueuePrompt(body.feedback, undefined, { sourceAdapterId: 'websocket' });
    }
    return { ok: true };
  }

  async function handleCancel(sessionId: string): Promise<{ ok: true }> {
    const session = deps.core.sessionManager.getSession(sessionId);
    if (!session) throw new Error('SESSION_NOT_FOUND');
    await session.abortPrompt();
    return { ok: true };
  }

  async function handleCommand(sessionId: string, request: any, params: unknown): Promise<{ result: unknown }> {
    if (!deps.commandRegistry) {
      throw new Error('COMMAND_REGISTRY_UNAVAILABLE');
    }
    const body = CommandParamsSchema.parse(params ?? {});
    const commandString = body.command.startsWith('/') ? body.command : `/${body.command}`;
    const result = await deps.commandRegistry.execute(commandString, {
      raw: '',
      sessionId,
      channelId: 'api',
      userId: (request as any).auth?.tokenId ?? 'api',
      reply: async () => {},
    });
    return { result };
  }

  app.get<{ Params: { sessionId: string } }>(
    '/sessions/:sessionId/ws',
    ({ websocket: true, preHandler: requireScopes('sessions:read') } as any),
    (async (socket: any, request: any) => {
      const { sessionId: rawId } = SessionIdParamSchema.parse(request.params);
      const sessionId = decodeParam(rawId);
      const session = deps.core.sessionManager.getSession(sessionId);

      if (!session) {
        socket.socket.send(serializeRpcError(null, -32004, 'Session not found', { sessionId }));
        socket.socket.close(1008, 'Session not found');
        return;
      }

      const tokenId = (request as any).auth?.tokenId ?? 'anonymous';
      let connectionId: string;
      try {
        connectionId = deps.connectionManager.addConnection(sessionId, tokenId, socket.socket as any).id;
      } catch (err) {
        socket.socket.send(serializeRpcError(null, -32013, 'Connection limit reached', { message: (err as Error).message }));
        socket.socket.close(1013, 'Connection limit reached');
        return;
      }

      socket.socket.send(serializeRpcNotification('transport/connected', { connectionId, sessionId }));

      socket.socket.on('message', async (raw: unknown) => {
        const text = Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(text);
        } catch {
          socket.socket.send(serializeRpcError(null, -32700, 'Parse error'));
          return;
        }

        const rpc = RpcRequestSchema.safeParse(parsedJson);
        if (!rpc.success) {
          socket.socket.send(serializeRpcError(null, -32600, 'Invalid Request'));
          return;
        }

        const id: JsonRpcId = rpc.data.id ?? null;
        try {
          switch (rpc.data.method) {
            case 'initialize': {
              if (rpc.data.id !== undefined) {
                socket.socket.send(serializeRpcSuccess(id, {
                  protocolVersion: '0.2',
                  transport: 'websocket',
                  capabilities: {
                    methods: ['session/prompt', 'session/permission', 'session/cancel', 'session/command', 'ping'],
                  },
                }));
              }
              return;
            }
            case 'session/prompt': {
              const result = await handlePrompt(sessionId, request, rpc.data.params);
              if (rpc.data.id !== undefined) socket.socket.send(serializeRpcSuccess(id, result));
              return;
            }
            case 'session/permission': {
              const result = await handlePermission(sessionId, rpc.data.params);
              if (rpc.data.id !== undefined) socket.socket.send(serializeRpcSuccess(id, result));
              return;
            }
            case 'session/cancel': {
              const result = await handleCancel(sessionId);
              if (rpc.data.id !== undefined) socket.socket.send(serializeRpcSuccess(id, result));
              return;
            }
            case 'session/command': {
              const result = await handleCommand(sessionId, request, rpc.data.params);
              if (rpc.data.id !== undefined) socket.socket.send(serializeRpcSuccess(id, result));
              return;
            }
            case 'ping': {
              if (rpc.data.id !== undefined) socket.socket.send(serializeRpcSuccess(id, { sessionId }));
              return;
            }
            default: {
              if (rpc.data.id !== undefined) {
                socket.socket.send(serializeRpcError(id, -32601, `Method not found: ${rpc.data.method}`));
              }
            }
          }
        } catch (err) {
          const code =
            err instanceof ServiceUnavailableError ? -32050 :
            (err as Error)?.message === 'SESSION_NOT_FOUND' ? -32004 :
            (err as Error)?.message === 'NO_PENDING_PERMISSION' ? -32040 :
            (err as Error)?.message === 'COMMAND_REGISTRY_UNAVAILABLE' ? -32070 :
            (err instanceof z.ZodError ? -32602 : -32000);
          const message =
            err instanceof ServiceUnavailableError ? err.message :
            (err as Error)?.message === 'SESSION_NOT_FOUND' ? 'Session not found' :
            (err as Error)?.message === 'NO_PENDING_PERMISSION' ? 'No matching pending permission request' :
            (err as Error)?.message === 'COMMAND_REGISTRY_UNAVAILABLE' ? 'Command registry not available' :
            (err instanceof z.ZodError ? 'Invalid params' : 'Internal error');
          if (rpc.data.id !== undefined) {
            socket.socket.send(serializeRpcError(id, code, message));
          }
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
