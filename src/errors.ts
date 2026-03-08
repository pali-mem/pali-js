export class PaliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaliError";
  }
}

export class ValidationError extends PaliError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`pali: invalid ${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

export class TransportError extends PaliError {
  constructor(message: string) {
    super(`pali: transport error: ${message}`);
    this.name = "TransportError";
  }
}

export class APIError extends PaliError {
  readonly statusCode: number;
  readonly code: string;
  readonly requestId: string;
  readonly body: string;

  constructor(params: {
    statusCode: number;
    code: string;
    message: string;
    requestId?: string;
    body?: string;
  }) {
    const requestId = params.requestId?.trim() ?? "";
    const base = `pali: ${params.statusCode} ${params.code}: ${params.message}`;
    super(requestId ? `${base} (request_id=${requestId})` : base);
    this.name = "APIError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.requestId = requestId;
    this.body = params.body ?? "";
  }
}

export class UnauthorizedError extends APIError {
  constructor(params: ConstructorParameters<typeof APIError>[0]) {
    super(params);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends APIError {
  constructor(params: ConstructorParameters<typeof APIError>[0]) {
    super(params);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends APIError {
  constructor(params: ConstructorParameters<typeof APIError>[0]) {
    super(params);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends APIError {
  constructor(params: ConstructorParameters<typeof APIError>[0]) {
    super(params);
    this.name = "ConflictError";
  }
}

export class RateLimitError extends APIError {
  constructor(params: ConstructorParameters<typeof APIError>[0]) {
    super(params);
    this.name = "RateLimitError";
  }
}
