export type MemoryTier = "auto" | "working" | "episodic" | "semantic";
export type SearchTier = "working" | "episodic" | "semantic";
export type SearchRetrievalKind = "auto" | "vector" | "entity";
export type MemoryKind = "raw_turn" | "observation" | "summary" | "event";
export type CreatedBy = "auto" | "user" | "system";
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type PostprocessJobStatus = "queued" | "running" | "succeeded" | "failed" | "dead_letter";
export type PostprocessJobType = "parser_extract" | "vector_upsert";

export interface HealthResponse {
  status: string;
  time: string;
}

export interface CreateTenantRequest {
  id: string;
  name: string;
}

export interface CreateTenantResponse {
  id: string;
  name: string;
  createdAt: Date;
}

export interface TenantStatsResponse {
  tenantId: string;
  memoryCount: number;
}

export interface StoreMemoryRequest {
  tenantId: string;
  content: string;
  tags?: string[];
  tier?: MemoryTier;
  kind?: MemoryKind;
  source?: string;
  createdBy?: CreatedBy;
}

export interface StoreMemoryResponse {
  id: string;
  createdAt: Date;
}

export interface StoreMemoryBatchRequest {
  items: StoreMemoryRequest[];
}

export interface StoreMemoryBatchResponse {
  items: StoreMemoryResponse[];
}

export interface SearchMemoryRequest {
  tenantId: string;
  query: string;
  topK?: number;
  minScore?: number;
  tiers?: SearchTier[];
  kinds?: MemoryKind[];
  retrievalKind?: SearchRetrievalKind;
  disableTouch?: boolean;
  debug?: boolean;
}

export interface MemoryResponse {
  id: string;
  tenantId: string;
  content: string;
  tier: SearchTier;
  tags: string[];
  source: string;
  createdBy: string;
  kind: string;
  recallCount: number;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  lastRecalledAt: Date;
}

export interface SearchPlanDebug {
  intent: string;
  confidence: number;
  entities?: string[];
  relations?: string[];
  timeConstraints?: string[];
  requiredEvidence?: string;
  fallbackPath?: string[];
}

export interface SearchRankingDebug {
  rank: number;
  memoryId: string;
  kind: string;
  tier: string;
  lexicalScore: number;
  queryOverlap: number;
  routeFit: number;
}

export interface SearchMemoryDebug {
  plan: SearchPlanDebug;
  ranking?: SearchRankingDebug[];
}

export interface SearchMemoryResponse {
  items: MemoryResponse[];
  debug?: SearchMemoryDebug;
}

export interface IngestMemoryResponse {
  ingestId: string;
  memoryIds: string[];
  jobIds: string[];
  acceptedAt: Date;
}

export interface ListPostprocessJobsRequest {
  tenantId: string;
  statuses?: PostprocessJobStatus[];
  types?: PostprocessJobType[];
  limit?: number;
}

export interface PostprocessJobResponse {
  id: string;
  ingestId: string;
  tenantId: string;
  memoryId: string;
  type: PostprocessJobType | string;
  status: PostprocessJobStatus | string;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string;
  leasedUntil: Date;
  lastError: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListPostprocessJobsResponse {
  items: PostprocessJobResponse[];
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface StoreMemoryAction {
  kind: "store";
  request: StoreMemoryRequest;
}

export interface DeleteMemoryAction {
  kind: "delete";
  memoryId: string;
}

export interface ReplaceMemoryAction {
  kind: "replace";
  memoryId: string;
  request: StoreMemoryRequest;
}

export type MemoryAction = StoreMemoryAction | DeleteMemoryAction | ReplaceMemoryAction;
