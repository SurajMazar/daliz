import { randomUUID } from 'node:crypto';
import { Inject, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { RealtimeMessage } from '@daliz/shared';
import type { Redis } from 'ioredis';
import type { Server, Socket } from 'socket.io';
import { ENV, type Env } from '../../config/env.js';
import { RequestContext } from '../../common/request-context.js';
import { REALTIME_CHANNEL, type RealtimeEnvelope } from '../../infra/realtime.js';
import { RedisService } from '../../infra/redis.js';
import { SessionService } from '../auth/session.service.js';
import { PlatformAccessService } from '../platform/platform-access.service.js';
import { DomainResolver } from '../tenancy/domain-resolver.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';

interface SocketState {
  token: string;
  sessionId: string;
  tenantId: string;
  userId: string;
}

const REVALIDATE_MS = 30_000;
const tenantRoom = (tenantId: string) => `t:${tenantId}`;
const userRoom = (tenantId: string, userId: string) => `t:${tenantId}:u:${userId}`;

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Tenant-scoped real-time channel. The connection authenticates with the same session
 * cookie as HTTP, resolves the tenant exactly like AccessGuard does (session + Host check),
 * and joins only its own tenant/user rooms. Clients can't subscribe to anything themselves.
 * Sessions are re-checked periodically; revoked sessions are disconnected.
 */
@WebSocketGateway({ path: '/api/v1/realtime', serveClient: false, transports: ['websocket', 'polling'], cors: false })
export class RealtimeGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger(RealtimeGateway.name);
  private subscriber: Redis | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly sessions: SessionService,
    private readonly domains: DomainResolver,
    private readonly platformAccess: PlatformAccessService,
    private readonly tenants: TenantContextService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.client.duplicate();
    await this.subscriber.subscribe(REALTIME_CHANNEL);
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        this.deliver(JSON.parse(raw) as RealtimeEnvelope);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message }, 'bad realtime message');
      }
    });
    this.timer = setInterval(() => void this.revalidateAll(), REVALIDATE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.subscriber?.quit().catch(() => undefined);
  }

  private deliver(envelope: RealtimeEnvelope): void {
    if (!this.server) return;
    const rooms = envelope.userIds === 'all' ? [tenantRoom(envelope.tenantId)] : envelope.userIds.map((u) => userRoom(envelope.tenantId, u));
    if (rooms.length) this.server.to(rooms).emit('message', envelope.message);
  }

  private reject(socket: Socket, reason: string): void {
    socket.emit('message', { type: 'session_ended', reason } satisfies RealtimeMessage);
    socket.disconnect(true);
  }

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const headers = socket.handshake.headers;
      // Cross-site WebSocket hijacking: browsers always send Origin; it must be one of ours.
      const origin = headers.origin;
      if (origin && !(await this.domains.isAllowedOrigin(origin, this.env.CORS_EXTRA_ORIGINS))) return this.reject(socket, 'origin');
      const token = cookieValue(headers.cookie, this.sessions.cookieName);
      const loaded = token ? await this.sessions.load(token) : null;
      if (!token || !loaded || loaded.stage !== 'active') return this.reject(socket, 'unauthenticated');
      const hostHeader = (headers['x-forwarded-host'] as string | undefined) ?? headers.host ?? '';
      const host = hostHeader.split(',')[0]!.trim().replace(/:\d+$/, '').toLowerCase();
      const domainTenantId = host ? await this.domains.resolveTenantId(host) : null;
      const session = {
        sessionId: loaded.id,
        accountId: loaded.accountId,
        email: loaded.account.email,
        name: loaded.account.name,
        stage: loaded.stage,
        mfaEnabled: loaded.account.mfaEnabled,
        activeTenantId: loaded.activeTenantId,
        supportSessionId: loaded.supportSessionId,
        stepUpUntil: null,
      };
      const platform = await this.platformAccess.principal(loaded.accountId);
      const resolved = await RequestContext.run({ requestId: randomUUID(), ip: socket.handshake.address, userAgent: headers['user-agent'] ?? null, host, domainTenantId, session }, () =>
        this.tenants.resolve(session, platform, domainTenantId),
      );
      const actor = resolved.context.actor;
      if (actor.type === 'api_key') return this.reject(socket, 'unauthorized');
      const userId = actor.type === 'user' ? actor.userId : actor.accountId;
      const state: SocketState = { token, sessionId: loaded.id, tenantId: resolved.context.tenantId, userId };
      socket.data = state;
      await socket.join([tenantRoom(state.tenantId), userRoom(state.tenantId, userId)]);
      socket.on('message', () => undefined); // clients have nothing to send
    } catch {
      this.reject(socket, 'unauthorized');
    }
  }

  /** Public for tests; runs on a timer in production. */
  async revalidateAll(): Promise<void> {
    if (!this.server) return;
    const sockets = await this.server.fetchSockets();
    for (const s of sockets) {
      const state = s.data as SocketState | undefined;
      if (!state?.token) continue;
      const loaded = await this.sessions.load(state.token).catch(() => null);
      const stillInTenant = loaded && loaded.stage === 'active' && (loaded.activeTenantId === state.tenantId || !!loaded.supportSessionId);
      if (!stillInTenant) {
        s.emit('message', { type: 'session_ended', reason: 'revoked' } satisfies RealtimeMessage);
        s.disconnect(true);
      }
    }
  }
}
