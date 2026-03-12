import { ValidationError } from "./errors";
import { Transport, parseDate, resolveConfig } from "./transport";
import type {
  CreateTenantRequest,
  CreateTenantResponse,
  HealthResponse,
  IngestMemoryResponse,
  ListPostprocessJobsRequest,
  ListPostprocessJobsResponse,
  MemoryResponse,
  PostprocessJobResponse,
  SearchMemoryDebug,
  SearchMemoryRequest,
  SearchMemoryResponse,
  SearchPlanDebug,
  SearchRankingDebug,
  StoreMemoryBatchRequest,
  StoreMemoryBatchResponse,
  StoreMemoryRequest,
  StoreMemoryResponse,
  TenantStatsResponse
} from "./types";

export interface PaliClientOptions {
  token?: string | null;
  timeoutMs?: number;
  maxRetries?: number;
  fetchFn?: typeof fetch;
  userAgent?: string;
}

export class PaliClient {
  private readonly transport: Transport;

  constructor(baseUrl?: string, options: PaliClientOptions = {}) {
    const config = resolveConfig({
      baseUrl,
      ...options
    });
    this.transport = new Transport(config);
  }

  setBearerToken(token: string | null): void {
    this.transport.setBearerToken(token);
  }

  async health(): Promise<HealthResponse> {
    const payload = await this.transport.requestJSON<{ status: unknown; time: unknown }>({
      method: "GET",
      path: "/health",
      retryable: true
    });
    return {
      status: asString(payload.status, "status"),
      time: asString(payload.time, "time")
    };
  }

  async createTenant(request: CreateTenantRequest): Promise<CreateTenantResponse> {
    const payload = await this.transport.requestJSON<{
      id: unknown;
      name: unknown;
      created_at: unknown;
    }>({
      method: "POST",
      path: "/v1/tenants",
      body: {
        id: requiredString(request.id, "id"),
        name: requiredString(request.name, "name")
      },
      retryable: false
    });
    return {
      id: asString(payload.id, "id"),
      name: asString(payload.name, "name"),
      createdAt: parseDate(asString(payload.created_at, "created_at"))
    };
  }

  async tenantStats(tenantId: string): Promise<TenantStatsResponse> {
    const tenant = requiredString(tenantId, "tenantId");
    const payload = await this.transport.requestJSON<{
      tenant_id: unknown;
      memory_count: unknown;
    }>({
      method: "GET",
      path: `/v1/tenants/${encodeURIComponent(tenant)}/stats`,
      retryable: true
    });
    return {
      tenantId: asString(payload.tenant_id, "tenant_id"),
      memoryCount: asNumber(payload.memory_count, "memory_count")
    };
  }

  async store(
    requestOrTenantId: StoreMemoryRequest | string,
    content?: string,
    extra: Omit<StoreMemoryRequest, "tenantId" | "content"> = {}
  ): Promise<StoreMemoryResponse> {
    const req =
      typeof requestOrTenantId === "string"
        ? {
            tenantId: requestOrTenantId,
            content: content ?? "",
            ...extra
          }
        : requestOrTenantId;
    const payload = await this.transport.requestJSON<{ id: unknown; created_at: unknown }>({
      method: "POST",
      path: "/v1/memory",
      body: serializeStore(req),
      retryable: false
    });
    return {
      id: asString(payload.id, "id"),
      createdAt: parseDate(asString(payload.created_at, "created_at"))
    };
  }

  async storeBatch(request: StoreMemoryBatchRequest | StoreMemoryRequest[]): Promise<StoreMemoryBatchResponse> {
    const items = Array.isArray(request) ? request : request.items;
    if (items.length === 0) {
      throw new ValidationError("items", "items must not be empty");
    }
    const payload = await this.transport.requestJSON<{ items: unknown }>({
      method: "POST",
      path: "/v1/memory/batch",
      body: {
        items: items.map(serializeStore)
      },
      retryable: false
    });
    const rawItems = asArray(payload.items, "items");
    return {
      items: rawItems.map((item) => {
        const record = asRecord(item, "items[]");
        return {
          id: asString(record.id, "id"),
          createdAt: parseDate(asString(record.created_at, "created_at"))
        };
      })
    };
  }

  async ingest(
    requestOrTenantId: StoreMemoryRequest | string,
    content?: string,
    extra: Omit<StoreMemoryRequest, "tenantId" | "content"> = {}
  ): Promise<IngestMemoryResponse> {
    const req =
      typeof requestOrTenantId === "string"
        ? {
            tenantId: requestOrTenantId,
            content: content ?? "",
            ...extra
          }
        : requestOrTenantId;
    const payload = await this.transport.requestJSON<{
      ingest_id: unknown;
      memory_ids: unknown;
      job_ids: unknown;
      accepted_at: unknown;
    }>({
      method: "POST",
      path: "/v1/memory/ingest",
      body: serializeStore(req),
      retryable: false
    });
    return parseIngestResponse(payload);
  }

  async ingestBatch(request: StoreMemoryBatchRequest | StoreMemoryRequest[]): Promise<IngestMemoryResponse> {
    const items = Array.isArray(request) ? request : request.items;
    if (items.length === 0) {
      throw new ValidationError("items", "items must not be empty");
    }
    const payload = await this.transport.requestJSON<{
      ingest_id: unknown;
      memory_ids: unknown;
      job_ids: unknown;
      accepted_at: unknown;
    }>({
      method: "POST",
      path: "/v1/memory/ingest/batch",
      body: {
        items: items.map(serializeStore)
      },
      retryable: false
    });
    return parseIngestResponse(payload);
  }

  async search(
    requestOrTenantId: SearchMemoryRequest | string,
    query?: string,
    extra: Omit<SearchMemoryRequest, "tenantId" | "query"> = {}
  ): Promise<SearchMemoryResponse> {
    const req =
      typeof requestOrTenantId === "string"
        ? {
            tenantId: requestOrTenantId,
            query: query ?? "",
            ...extra
          }
        : requestOrTenantId;

    const payload = await this.transport.requestJSON<{ items: unknown; debug?: unknown }>({
      method: "POST",
      path: "/v1/memory/search",
      body: serializeSearch(req),
      retryable: true
    });
    const items = asArray(payload.items, "items").map(parseMemory);
    const debug = payload.debug === undefined ? undefined : parseSearchDebug(payload.debug);
    return { items, debug };
  }

  async deleteMemory(tenantId: string, memoryId: string): Promise<void> {
    const tenant = requiredString(tenantId, "tenantId");
    const memory = requiredString(memoryId, "memoryId");
    await this.transport.requestJSON<void>({
      method: "DELETE",
      path: `/v1/memory/${encodeURIComponent(memory)}`,
      params: { tenant_id: tenant },
      retryable: true
    });
  }

  async listPostprocessJobs(request: ListPostprocessJobsRequest): Promise<ListPostprocessJobsResponse> {
    const tenantId = requiredString(request.tenantId, "tenantId");
    const payload = await this.transport.requestJSON<{ items: unknown }>({
      method: "GET",
      path: "/v1/memory/jobs",
      params: {
        tenant_id: tenantId,
        ...(request.limit && request.limit > 0 ? { limit: String(request.limit) } : {}),
        ...(request.statuses && request.statuses.length > 0 ? { status: joinCSV(request.statuses) } : {}),
        ...(request.types && request.types.length > 0 ? { type: joinCSV(request.types) } : {})
      },
      retryable: true
    });
    const items = asArray(payload.items, "items").map(parsePostprocessJob);
    return { items };
  }

  async getPostprocessJob(jobId: string): Promise<PostprocessJobResponse> {
    const id = requiredString(jobId, "jobId");
    const payload = await this.transport.requestJSON<Record<string, unknown>>({
      method: "GET",
      path: `/v1/memory/jobs/${encodeURIComponent(id)}`,
      retryable: true
    });
    return parsePostprocessJob(payload);
  }
}

function serializeStore(request: StoreMemoryRequest): Record<string, unknown> {
  const tenantId = requiredString(request.tenantId, "tenantId");
  const content = requiredString(request.content, "content");
  return {
    tenant_id: tenantId,
    content,
    tags: request.tags ?? [],
    tier: request.tier ?? "auto",
    kind: request.kind ?? "raw_turn",
    source: request.source ?? "",
    created_by: request.createdBy ?? "auto"
  };
}

function serializeSearch(request: SearchMemoryRequest): Record<string, unknown> {
  const tenantId = requiredString(request.tenantId, "tenantId");
  const query = requiredString(request.query, "query");
  const topK = request.topK && request.topK > 0 ? request.topK : 10;
  const minScore = request.minScore ?? 0;
  if (minScore < 0 || minScore > 1) {
    throw new ValidationError("minScore", "minScore must be between 0 and 1");
  }
  return {
    tenant_id: tenantId,
    query,
    top_k: topK,
    min_score: minScore,
    tiers: request.tiers ?? [],
    kinds: request.kinds ?? [],
    retrieval_kind: request.retrievalKind ?? "auto",
    disable_touch: request.disableTouch ?? false,
    debug: request.debug ?? false
  };
}

function parseIngestResponse(raw: Record<string, unknown>): IngestMemoryResponse {
  return {
    ingestId: asString(raw.ingest_id, "ingest_id"),
    memoryIds: asArray(raw.memory_ids, "memory_ids").map((v) => asString(v, "memory_ids[]")),
    jobIds: asArray(raw.job_ids, "job_ids").map((v) => asString(v, "job_ids[]")),
    acceptedAt: parseDate(asString(raw.accepted_at, "accepted_at"))
  };
}

function parseMemory(raw: unknown): MemoryResponse {
  const record = asRecord(raw, "memory");
  return {
    id: asString(record.id, "id"),
    tenantId: asString(record.tenant_id, "tenant_id"),
    content: asString(record.content, "content"),
    tier: asString(record.tier, "tier") as MemoryResponse["tier"],
    tags: asArray(record.tags, "tags").map((t) => asString(t, "tag")),
    source: asString(record.source ?? "", "source"),
    createdBy: asString(record.created_by ?? "", "created_by"),
    kind: asString(record.kind ?? "", "kind"),
    recallCount: asNumber(record.recall_count, "recall_count"),
    createdAt: parseDate(asString(record.created_at, "created_at")),
    updatedAt: parseDate(asString(record.updated_at, "updated_at")),
    lastAccessedAt: parseDate(asString(record.last_accessed_at, "last_accessed_at")),
    lastRecalledAt: parseDate(asString(record.last_recalled_at, "last_recalled_at"))
  };
}

function parseSearchDebug(raw: unknown): SearchMemoryDebug {
  const record = asRecord(raw, "debug");
  const plan = asRecord(record.plan, "debug.plan");
  const rankingRaw = record.ranking === undefined ? [] : asArray(record.ranking, "debug.ranking");
  const parsedPlan: SearchPlanDebug = {
    intent: asString(plan.intent, "intent"),
    confidence: asNumber(plan.confidence, "confidence"),
    entities: plan.entities === undefined ? undefined : asArray(plan.entities, "entities").map((v) => asString(v, "entities[]")),
    relations: plan.relations === undefined ? undefined : asArray(plan.relations, "relations").map((v) => asString(v, "relations[]")),
    timeConstraints:
      plan.time_constraints === undefined
        ? undefined
        : asArray(plan.time_constraints, "time_constraints").map((v) => asString(v, "time_constraints[]")),
    requiredEvidence:
      plan.required_evidence === undefined ? undefined : asString(plan.required_evidence, "required_evidence"),
    fallbackPath:
      plan.fallback_path === undefined
        ? undefined
        : asArray(plan.fallback_path, "fallback_path").map((v) => asString(v, "fallback_path[]"))
  };
  const ranking: SearchRankingDebug[] = rankingRaw.map((item) => {
    const r = asRecord(item, "ranking[]");
    return {
      rank: asNumber(r.rank, "rank"),
      memoryId: asString(r.memory_id, "memory_id"),
      kind: asString(r.kind, "kind"),
      tier: asString(r.tier, "tier"),
      lexicalScore: asNumber(r.lexical_score, "lexical_score"),
      queryOverlap: asNumber(r.query_overlap, "query_overlap"),
      routeFit: asNumber(r.route_fit, "route_fit")
    };
  });
  return {
    plan: parsedPlan,
    ranking
  };
}

function parsePostprocessJob(raw: unknown): PostprocessJobResponse {
  const record = asRecord(raw, "postprocess_job");
  return {
    id: asString(record.id, "id"),
    ingestId: asString(record.ingest_id, "ingest_id"),
    tenantId: asString(record.tenant_id, "tenant_id"),
    memoryId: asString(record.memory_id, "memory_id"),
    type: asString(record.type, "type"),
    status: asString(record.status, "status"),
    attempts: asNumber(record.attempts, "attempts"),
    maxAttempts: asNumber(record.max_attempts, "max_attempts"),
    availableAt: parseDate(asString(record.available_at, "available_at")),
    leaseOwner: asString(record.lease_owner ?? "", "lease_owner"),
    leasedUntil: parseDate(asString(record.leased_until ?? "0001-01-01T00:00:00Z", "leased_until")),
    lastError: asString(record.last_error ?? "", "last_error"),
    createdAt: parseDate(asString(record.created_at, "created_at")),
    updatedAt: parseDate(asString(record.updated_at, "updated_at"))
  };
}

function joinCSV(values: string[]): string {
  return values.map((v) => v.trim()).filter((v) => v.length > 0).join(",");
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(field, `${field} is required`);
  }
  return trimmed;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(field, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(field, `${field} must be a string`);
  }
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(field, `${field} must be a number`);
  }
  return value;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(field, `${field} must be an array`);
  }
  return value;
}
