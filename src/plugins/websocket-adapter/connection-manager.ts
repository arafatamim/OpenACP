import { randomBytes } from 'node:crypto';

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, data?: string): void;
  on(event: 'close', listener: () => void): void;
  readyState: number;
}

export interface WSConnection {
  id: string;
  sessionId: string;
  tokenId: string;
  socket: WebSocketLike;
  connectedAt: Date;
}

export class WSConnectionManager {
  private connections = new Map<string, WSConnection>();
  private sessionIndex = new Map<string, Set<string>>();
  private maxConnectionsPerSession: number;
  private maxTotalConnections: number;

  constructor(opts?: { maxPerSession?: number; maxTotal?: number }) {
    this.maxConnectionsPerSession = opts?.maxPerSession ?? 10;
    this.maxTotalConnections = opts?.maxTotal ?? 100;
  }

  addConnection(sessionId: string, tokenId: string, socket: WebSocketLike): WSConnection {
    if (this.connections.size >= this.maxTotalConnections) {
      throw new Error('Maximum total connections reached');
    }

    const sessionConns = this.sessionIndex.get(sessionId);
    if (sessionConns && sessionConns.size >= this.maxConnectionsPerSession) {
      throw new Error('Maximum connections per session reached');
    }

    const id = `ws_${randomBytes(8).toString('hex')}`;
    const connection: WSConnection = { id, sessionId, tokenId, socket, connectedAt: new Date() };
    this.connections.set(id, connection);

    let connSet = this.sessionIndex.get(sessionId);
    if (!connSet) {
      connSet = new Set();
      this.sessionIndex.set(sessionId, connSet);
    }
    connSet.add(id);

    socket.on('close', () => this.removeConnection(id));

    return connection;
  }

  removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.connections.delete(connectionId);
    const sessionConns = this.sessionIndex.get(conn.sessionId);
    if (sessionConns) {
      sessionConns.delete(connectionId);
      if (sessionConns.size === 0) this.sessionIndex.delete(conn.sessionId);
    }
  }

  getConnectionsBySession(sessionId: string): WSConnection[] {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return [];
    return Array.from(ids)
      .map((id) => this.connections.get(id))
      .filter((c): c is WSConnection => c !== undefined);
  }

  broadcast(sessionId: string, payload: string): void {
    for (const conn of this.getConnectionsBySession(sessionId)) {
      try {
        if (conn.socket.readyState === 1) {
          conn.socket.send(payload);
        } else {
          this.removeConnection(conn.id);
        }
      } catch {
        this.removeConnection(conn.id);
      }
    }
  }

  disconnectByToken(tokenId: string): void {
    for (const [id, conn] of this.connections) {
      if (conn.tokenId === tokenId) {
        try {
          conn.socket.close(1008, 'Token revoked');
        } catch {
          // noop
        }
        this.removeConnection(id);
      }
    }
  }

  listConnections(): WSConnection[] {
    return Array.from(this.connections.values());
  }

  cleanup(): void {
    for (const [, conn] of this.connections) {
      try {
        conn.socket.close(1001, 'Server shutdown');
      } catch {
        // noop
      }
    }
    this.connections.clear();
    this.sessionIndex.clear();
  }
}

