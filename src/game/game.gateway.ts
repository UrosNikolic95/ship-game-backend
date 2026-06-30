import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { randomUUID } from 'crypto';
import type { Server, Socket } from 'socket.io';

// A live position broadcast for one player's ship. This is presence only —
// ephemeral and never persisted (the authoritative ship position is still saved
// over HTTP). `id` is the player's user id so clients can track ships over time.
interface ShipPresence {
  id: string;
  name: string;
  x: number;
  y: number;
  heading: number;
  boatId: string;
}

// Payload a client sends as its ship moves.
interface MoveMessage {
  x: number;
  y: number;
  heading: number;
  boatId: string;
}

const USER_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// Real-time presence channel: every connected client streams its ship position
// here, and the gateway relays each ship to all *other* players so everyone sees
// everyone else sailing live. Runs on the same HTTP server as the REST API.
//
// The Socket.IO endpoint lives under `/api/socket.io` (instead of the default
// `/socket.io`) so that, in production, the same nginx rule that proxies `/api`
// to this backend also covers the WebSocket traffic. The client sets a matching
// `path` (see presence.service.ts).
@WebSocketGateway({
  path: '/api/socket.io',
  cors: { origin: true, credentials: true },
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);

  @WebSocketServer()
  private server!: Server;

  // Latest known position for each online player, keyed by user id.
  private readonly presence = new Map<string, ShipPresence>();
  // Which sockets belong to each user (a user may have several tabs open), so a
  // player only "leaves" once their last socket disconnects.
  private readonly sockets = new Map<string, Set<string>>();

  handleConnection(client: Socket): void {
    const userId = this.identify(client);
    client.data.userId = userId;
    // Group a user's sockets in a room named by their id, so we can broadcast to
    // "everyone except this user" (all their tabs) in one call.
    void client.join(userId);

    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(client.id);

    // Tell the newcomer who is already out there. Skip their own ship.
    const others = [...this.presence.values()].filter((s) => s.id !== userId);
    client.emit('presence:snapshot', others);
    this.logger.log(`Socket connected for ${userId} (${client.id})`);
  }

  handleDisconnect(client: Socket): void {
    const userId: string = client.data.userId;
    if (!userId) return;
    const set = this.sockets.get(userId);
    set?.delete(client.id);
    // Only drop the player once their last tab is gone.
    if (set && set.size === 0) {
      this.sockets.delete(userId);
      this.presence.delete(userId);
      // Tell everyone else this ship is gone.
      client.broadcast.emit('presence:leave', { id: userId });
    }
    this.logger.log(`Socket disconnected for ${userId} (${client.id})`);
  }

  @SubscribeMessage('presence:move')
  onMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: MoveMessage,
  ): void {
    const userId: string = client.data.userId;
    if (
      !userId ||
      !body ||
      typeof body.x !== 'number' ||
      typeof body.y !== 'number'
    ) {
      return;
    }

    const ship: ShipPresence = {
      id: userId,
      name: this.nameFor(userId),
      x: body.x,
      y: body.y,
      heading: typeof body.heading === 'number' ? body.heading : 0,
      boatId: typeof body.boatId === 'string' ? body.boatId : 'sloop',
    };
    this.presence.set(userId, ship);

    // Relay to every other player (all sockets except this user's own tabs).
    this.server.except(userId).emit('presence:update', ship);
  }

  // Pull the player's user id out of the handshake cookie so presence lines up
  // with the same identity used by the REST API. Falls back to a random id if no
  // valid cookie is present (e.g. a client that connected before fetching state).
  private identify(client: Socket): string {
    const header = client.handshake.headers.cookie;
    if (header) {
      for (const part of header.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === 'shipGameUser') {
          const value = decodeURIComponent(rest.join('='));
          if (USER_ID_RE.test(value)) return value;
        }
      }
    }
    return randomUUID();
  }

  // A short, stable display name derived from the user id, so other players show
  // up as e.g. "Sailor 4f3a" rather than a raw UUID.
  private nameFor(userId: string): string {
    return `Sailor ${userId
      .replace(/[^a-f0-9]/gi, '')
      .slice(0, 4)
      .toUpperCase()}`;
  }
}
