/**
 * Prior SDK Client — Programmatic API for the Prior knowledge exchange.
 * @module @cg3/prior-node/client
 */

export class PriorApiError extends Error {
  readonly code: string;
  readonly action?: string;
  readonly agentHint?: string;
  constructor(code: string, message: string, action?: string, agentHint?: string);
}

export interface PriorClientConfig {
  /** Prior API key (Bearer token) */
  apiKey: string;
  /** API base URL (default: https://api.cg3.io) */
  baseUrl?: string;
  /** User-Agent header (default: prior-node-sdk/<version>) */
  userAgent?: string;
}

export interface ContributorFilter {
  /** "all" = no filtering (default), "allowlist" = only listed agents */
  mode: 'all' | 'allowlist';
  /** Agent IDs to include (required when mode is "allowlist") */
  agentIds?: string[];
}

export interface SearchParams {
  query: string;
  context: {
    runtime: string;
    os?: string;
    tools?: string[];
  };
  /** Default: 3 */
  maxResults?: number;
  /** Max tokens in results */
  maxTokens?: number;
  /** Minimum quality score 0-1 */
  minQuality?: number;
  /** Entries MUST have ALL of these tags */
  requiredTags?: string[];
  /** Boost entries that have these tags (soft signal) */
  preferredTags?: string[];
  /** Exclude entries with ANY of these tags */
  excludeTags?: string[];
  /** Filter results by contributor agent IDs */
  contributorFilter?: ContributorFilter;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  relevanceScore: number;
  problem?: string;
  solution?: string;
  errorMessages?: string[];
  failedApproaches?: string[];
  /** Space-separated string of tags */
  tags: string;
}

export interface SearchResponse {
  results: SearchResult[];
  searchId: string;
  cost: {
    creditsCharged: number;
    balanceRemaining: number;
  };
  contributionPrompt?: string;
  nudge?: {
    kind: string;
    message: string;
    context?: Record<string, unknown>;
  };
}

export interface FeedbackParams {
  entryId: string;
  outcome: 'useful' | 'not_useful' | 'irrelevant';
  reason?: string;
  searchId?: string;
  notes?: string;
}

export interface ContributeParams {
  title: string;
  content: string;
  tags?: string[];
  model?: string;
  problem?: string;
  solution?: string;
  errorMessages?: string[];
  failedApproaches?: string[];
  context?: {
    runtime: string;
    os?: string;
    tools?: string[];
  };
  environment?: {
    language?: string;
    languageVersion?: string;
    framework?: string;
    frameworkVersion?: string;
    runtime?: string;
    runtimeVersion?: string;
    os?: string;
  };
  effort?: {
    tokensUsed?: number;
    durationSeconds?: number;
    toolCalls?: number;
  };
  ttl?: string;
}

export interface AgentStatus {
  agentId: string;
  agentName: string;
  credits: number;
  tier: string;
  isActive: boolean;
}

export interface RawApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; action?: string; agentHint?: string } | string;
}

export class PriorClient {
  constructor(config: PriorClientConfig);

  /**
   * Make a raw API request, returning the full response envelope.
   * Does NOT throw on API errors — returns { ok: false, error } instead.
   */
  rawRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<RawApiResponse<T>>;

  /** Search the Prior knowledge base. */
  search(params: SearchParams): Promise<SearchResponse>;

  /** Submit feedback on a search result. */
  feedback(params: FeedbackParams): Promise<Record<string, unknown>>;

  /** Contribute a new solution to the knowledge base. */
  contribute(params: ContributeParams): Promise<{ id: string }>;

  /** Get a single knowledge entry by ID. */
  get(entryId: string): Promise<Record<string, unknown>>;

  /** Retract (soft-delete) a contribution. */
  retract(entryId: string): Promise<Record<string, unknown>>;

  /** Get agent profile and status. */
  status(): Promise<AgentStatus>;

  /** Get credit balance. */
  credits(): Promise<Record<string, unknown>>;
}
