import { randomUUID } from 'node:crypto';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RequestContext } from '../request-context.js';
import { DomainResolver } from '../../modules/tenancy/domain-resolver.js';

const REQUEST_ID = /^[a-zA-Z0-9-]{8,64}$/;

/**
 * First middleware for every request: assigns a request id, captures client metadata and
 * resolves any tenant implied by the Host header, then runs the rest of the request inside
 * an AsyncLocalStorage scope.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly domains: DomainResolver) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);

    // req.hostname honours X-Forwarded-Host only for trusted proxies (see "trust proxy").
    const host = req.hostname?.toLowerCase() ?? null;
    let domainTenantId: string | null = null;
    try {
      domainTenantId = host ? await this.domains.resolveTenantId(host) : null;
    } catch (err) {
      next(err);
      return;
    }

    RequestContext.run(
      {
        requestId,
        ip: req.ip ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        host,
        domainTenantId,
      },
      () => next(),
    );
  }
}
