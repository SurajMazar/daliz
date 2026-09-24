import { Body, type PipeTransform, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBody, ApiQuery } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';
import { Errors } from '../errors.js';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (!result.success) {
      throw Errors.validation(
        result.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
      );
    }
    return result.data;
  }
}

type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[] } & Record<string, unknown>;

function toJsonSchema(schema: ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
}

function describe(target: object, key: string | symbol | undefined, apply: (descriptor: PropertyDescriptor) => void) {
  if (!key) return;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor) apply(descriptor);
}

/**
 * Validated request body. The schema is the only thing that reaches the handler, and the
 * same schema documents the endpoint in OpenAPI.
 */
export const ZBody =
  <T>(schema: ZodType<T>): ParameterDecorator =>
  (target, key, index) => {
    Body(new ZodValidationPipe(schema))(target, key, index);
    describe(target, key, (d) => ApiBody({ schema: toJsonSchema(schema) as never })(target, key!, d));
  };

export const ZQuery =
  <T>(schema: ZodType<T>): ParameterDecorator =>
  (target, key, index) => {
    Query(new ZodValidationPipe(schema))(target, key, index);
    const json = toJsonSchema(schema);
    describe(target, key, (d) => {
      for (const [name, prop] of Object.entries(json.properties ?? {})) {
        ApiQuery({ name, required: json.required?.includes(name) ?? false, schema: prop as never })(target, key!, d);
      }
    });
  };

class UuidPipe extends ParseUUIDPipe {
  constructor() {
    super({ version: undefined, exceptionFactory: () => Errors.notFound() });
  }
}

/** Route id parameter; anything that isn't a UUID is a 404, not a database error. */
export const IdParam = (name = 'id') => Param(name, UuidPipe);
