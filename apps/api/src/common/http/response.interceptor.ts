import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor, StreamableFile } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import { META } from './decorators.js';

function isPaginated(v: unknown): v is { items: unknown[]; meta: { page: number; pageSize: number; total: number } } {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as { items?: unknown }).items) &&
    typeof (v as { meta?: { total?: unknown } }).meta?.total === 'number'
  );
}

/** Wraps handler results in the { success: true, data, meta? } envelope. */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(META.rawResponse, [ctx.getHandler(), ctx.getClass()]);
    return next.handle().pipe(
      map((value: unknown) => {
        if (raw || value instanceof StreamableFile) return value;
        if (isPaginated(value)) return { success: true, data: value.items, meta: value.meta };
        return { success: true, data: value ?? null };
      }),
    );
  }
}
