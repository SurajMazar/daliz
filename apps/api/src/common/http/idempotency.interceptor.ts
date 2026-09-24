import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { catchError, concatMap, from, map, of, switchMap, throwError, type Observable } from 'rxjs';
import { sha256Hex } from '../crypto.js';
import { Errors } from '../errors.js';
import { RequestContext } from '../request-context.js';
import { idempotencyKeys } from '../../database/tenant/schema.js';
import { META } from './decorators.js';

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;
const TTL_MS = 24 * 3600_000;

/** Deterministic JSON so logically identical bodies hash the same. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * Stores the first response for (user, Idempotency-Key) in the tenant database. Retries with
 * the same key and body replay it; the same key with a different body is rejected; a key
 * whose first request is still running is rejected with 409 so it can't execute twice.
 * Offline clients use their operation id as the key when syncing queued mutations.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(META.idempotent, ctx.getHandler())) return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers['idempotency-key'];
    if (key === undefined) return next.handle();
    if (typeof key !== 'string' || !KEY_FORMAT.test(key)) {
      throw Errors.badRequest('Idempotency-Key must be 8–100 characters of letters, digits, "-" or "_".');
    }
    const tenant = RequestContext.tenant();
    const a = tenant.actor;
    // Idempotency keys are namespaced per caller: user, support operator or API key.
    const userId = a.type === 'user' ? a.userId : a.type === 'support' ? a.accountId : a.keyId;
    const route = `${req.method} ${(req.route as { path?: string } | undefined)?.path ?? req.path}`;
    const requestHash = sha256Hex(`${route}\n${req.path}\n${stableStringify(req.body ?? null)}`);
    const db = tenant.db;

    return from(
      db
        .insert(idempotencyKeys)
        .values({ userId, key, route, requestHash, expiresAt: new Date(Date.now() + TTL_MS) })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key }),
    ).pipe(
      switchMap((inserted) => {
        if (inserted.length) {
          return next.handle().pipe(
            // Persist before responding, so an immediate retry replays instead of seeing "in progress".
            concatMap((result) =>
              from(
                db
                  .update(idempotencyKeys)
                  .set({ statusCode: res.statusCode, response: (result ?? null) as never })
                  .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key))),
              ).pipe(map(() => result)),
            ),
            catchError((err: unknown) =>
              // Failed requests don't consume the key, so the client can retry.
              from(db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))).pipe(
                switchMap(() => throwError(() => err)),
              ),
            ),
          );
        }
        return from(
          db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key))),
        ).pipe(
          switchMap(([row]) => {
            if (!row || row.requestHash !== requestHash) throw Errors.idempotencyConflict();
            if (row.statusCode === null) throw Errors.conflict('A request with this idempotency key is still being processed.');
            res.status(row.statusCode);
            res.setHeader('Idempotent-Replayed', 'true');
            return of(row.response);
          }),
        );
      }),
    );
  }
}
