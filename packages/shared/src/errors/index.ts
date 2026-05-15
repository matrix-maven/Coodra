/**
 * Typed error hierarchy for Coodra services.
 *
 * Every service throws specific subclasses. HTTP handlers translate these
 * into status codes via `error.statusCode`; MCP tool handlers translate
 * them into `{ isError: true, content: [...] }` responses.
 *
 * See `essentialsforclaude/01-development-discipline.md` §1.4: generic
 * `Error` is not acceptable at service boundaries. Catching and re-throwing
 * as a typed error preserves the original via `cause`.
 */

export interface AppErrorOptions {
  readonly code: string;
  readonly statusCode: number;
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    if (options.cause !== undefined) {
      // Error.prototype already exposes `cause` since ES2022 when set via
      // `new Error(msg, { cause })`. We also allow constructing without
      // the options arg, so assign explicitly.
      (this as { cause?: unknown }).cause = options.cause;
    }
    // Preserve prototype chain when this file is transpiled down.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** JSON-serializable representation for log lines and HTTP responses. */
  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

/** 400 — request shape or semantic validation failed. */
export class ValidationError extends AppError {
  constructor(message: string, cause?: unknown, details?: Readonly<Record<string, unknown>>) {
    super(message, {
      code: 'VALIDATION_ERROR',
      statusCode: 400,
      ...(cause !== undefined ? { cause } : {}),
      ...(details !== undefined ? { details } : {}),
    });
  }
}

/** 401 — caller is not authenticated. */
export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthenticated', cause?: unknown) {
    super(message, {
      code: 'UNAUTHORIZED',
      statusCode: 401,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** 403 — caller is authenticated but not permitted. */
export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', cause?: unknown) {
    super(message, {
      code: 'FORBIDDEN',
      statusCode: 403,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** 404 — the target entity does not exist. */
export class NotFoundError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: 'NOT_FOUND',
      statusCode: 404,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** 409 — idempotency or uniqueness conflict. */
export class ConflictError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: 'CONFLICT',
      statusCode: 409,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/** 500 — unexpected internal state. Only thrown by code that cannot continue. */
export class InternalError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      code: 'INTERNAL',
      statusCode: 500,
      ...(cause !== undefined ? { cause } : {}),
    });
  }
}

/**
 * Narrowing helper for use in HTTP/MCP boundary handlers:
 * `if (isAppError(err)) { respond(err.statusCode, err.toJSON()); }`.
 */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
