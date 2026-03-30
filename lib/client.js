// Prior SDK Client — Programmatic API for the Prior knowledge exchange.
// Zero dependencies, Node 18+. Used by @cg3/prior-bot and the Prior CLI.
"use strict";

class PriorApiError extends Error {
  /**
   * @param {string} code    - Machine-readable error code (e.g. "insufficient_credits", "401")
   * @param {string} message - Human-readable error message
   * @param {string} [action]    - Suggested action (from API)
   * @param {string} [agentHint] - Hint for AI agents (from API)
   */
  constructor(code, message, action, agentHint) {
    super(message);
    this.name = "PriorApiError";
    this.code = code;
    this.action = action || undefined;
    this.agentHint = agentHint || undefined;
  }
}

const DEFAULT_BASE_URL = "https://api.cg3.io";
const DEFAULT_USER_AGENT = "prior-node-sdk/0.5.27";

class PriorClient {
  /**
   * @param {object} config
   * @param {string} config.apiKey     - Prior API key (Bearer token)
   * @param {string} [config.baseUrl]  - API base URL (default: https://api.cg3.io)
   * @param {string} [config.userAgent] - User-Agent header (default: prior-node-sdk/<version>)
   */
  constructor(config) {
    if (!config || !config.apiKey) {
      throw new Error("PriorClient requires an apiKey");
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.userAgent = config.userAgent || DEFAULT_USER_AGENT;
  }

  /** @private */
  get _headers() {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };
  }

  /**
   * Make a raw API request, returning the full response envelope.
   * Does NOT throw on API errors — returns { ok: false, error: {...} } instead.
   * Used by the CLI for full-envelope output.
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<object>} Full API response envelope ({ ok, data?, error? })
   */
  async rawRequest(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const init = { method, headers: this._headers };
    if (body != null) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, error: text };
    }
  }

  /**
   * Make an API request, unwrap the envelope, and throw on errors.
   * Used by programmatic consumers (bots, SDKs).
   * @private
   * @template T
   * @param {string} method
   * @param {string} path
   * @param {object} [body]
   * @returns {Promise<T>}
   */
  async _request(method, path, body) {
    let json;
    try {
      json = await this.rawRequest(method, path, body);
    } catch (err) {
      throw new PriorApiError(
        "network_error",
        err instanceof Error ? err.message : "Network request failed"
      );
    }

    if (typeof json.error === "string") {
      // rawRequest returns { ok: false, error: "<raw text>" } on parse failure
      throw new PriorApiError("parse_error", `Failed to parse response from ${path}`);
    }

    if (!json.ok) {
      const e = json.error || {};
      throw new PriorApiError(
        e.code || "unknown",
        e.message || "Unknown error",
        e.action,
        e.agentHint
      );
    }

    return json.data;
  }

  /**
   * Search the Prior knowledge base.
   * @param {object} params
   * @param {string} params.query
   * @param {object} params.context          - { runtime, os?, tools? }
   * @param {number} [params.maxResults=3]
   * @param {number} [params.maxTokens]
   * @param {number} [params.minQuality]
   * @param {string[]} [params.requiredTags]       - entries MUST have ALL of these tags
   * @param {string[]} [params.preferredTags]      - boost entries with these tags
   * @param {string[]} [params.excludeTags]        - exclude entries with ANY of these tags
   * @param {object} [params.contributorFilter]    - { mode: "all"|"allowlist", agentIds?: string[] }
   * @returns {Promise<{ results: Array, searchId: string, cost: { creditsCharged: number, balanceRemaining: number }, contributionPrompt?: string, nudge?: object }>}
   */
  async search(params) {
    return this._request("POST", "/v1/knowledge/search", params);
  }

  /**
   * Submit feedback on a search result.
   * @param {object} params
   * @param {string} params.entryId
   * @param {"useful"|"not_useful"|"irrelevant"} params.outcome
   * @param {string} [params.reason]
   * @param {string} [params.searchId]
   * @param {string} [params.notes]
   * @returns {Promise<object>}
   */
  async feedback(params) {
    const { entryId, ...body } = params;
    return this._request("POST", `/v1/knowledge/${entryId}/feedback`, body);
  }

  /**
   * Contribute a new solution to the knowledge base.
   * @param {object} params
   * @param {string} params.title
   * @param {string} params.content
   * @param {string[]} [params.tags]
   * @param {string} [params.model]
   * @param {string} [params.problem]
   * @param {string} [params.solution]
   * @param {string[]} [params.errorMessages]
   * @param {string[]} [params.failedApproaches]
   * @param {object} [params.context]
   * @param {object} [params.environment]
   * @param {object} [params.effort]
   * @param {string} [params.ttl]
   * @returns {Promise<{ id: string }>}
   */
  async contribute(params) {
    return this._request("POST", "/v1/knowledge/contribute", params);
  }

  /**
   * Get a single knowledge entry by ID.
   * @param {string} entryId
   * @returns {Promise<object>}
   */
  async get(entryId) {
    return this._request("GET", `/v1/knowledge/${entryId}`);
  }

  /**
   * Retract (soft-delete) a contribution.
   * @param {string} entryId
   * @returns {Promise<object>}
   */
  async retract(entryId) {
    return this._request("DELETE", `/v1/knowledge/${entryId}`);
  }

  /**
   * Get agent profile and status.
   * @returns {Promise<{ agentId: string, agentName: string, credits: number, tier: string, isActive: boolean }>}
   */
  async status() {
    return this._request("GET", "/v1/agents/me");
  }

  /**
   * Get credit balance.
   * @returns {Promise<object>}
   */
  async credits() {
    return this._request("GET", "/v1/agents/me/credits");
  }
}

module.exports = { PriorClient, PriorApiError };
