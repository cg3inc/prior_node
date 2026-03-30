const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PriorClient, PriorApiError } = require("../lib/client.js");

// --- Mock server ---

function createMockServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function jsonResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// --- Tests ---

describe("PriorClient", () => {
  let mock, client;

  // We'll set up a fresh mock per test group
  const routes = {};

  before(async () => {
    const result = await createMockServer((req, res) => {
      // Collect body
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : null;
        const key = `${req.method} ${req.url}`;
        const handler = routes[key] || routes["*"];
        if (handler) {
          handler(req, res, body);
        } else {
          jsonResponse(res, 404, { ok: false, error: { code: "not_found", message: "Not found" } });
        }
      });
    });
    mock = result;
    client = new PriorClient({ apiKey: "test-key", baseUrl: result.baseUrl });
  });

  after(() => {
    mock.server.close();
  });

  describe("constructor", () => {
    it("throws if no apiKey", () => {
      assert.throws(() => new PriorClient({}), /apiKey/);
      assert.throws(() => new PriorClient(), /apiKey/);
    });

    it("strips trailing slash from baseUrl", () => {
      const c = new PriorClient({ apiKey: "k", baseUrl: "http://example.com/" });
      assert.equal(c.baseUrl, "http://example.com");
    });
  });

  describe("search", () => {
    it("returns parsed results on success", async () => {
      routes["POST /v1/knowledge/search"] = (req, res, body) => {
        jsonResponse(res, 200, {
          ok: true,
          data: {
            results: [
              { id: "k_1", title: "Fix", content: "Do this", relevanceScore: 0.85, tags: "node typescript" },
            ],
            searchId: "s_123",
            cost: { creditsCharged: 100, balanceRemaining: 9900 },
          },
        });
      };

      const result = await client.search({ query: "test error", context: { runtime: "node" } });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0].id, "k_1");
      assert.equal(result.results[0].tags, "node typescript");
      assert.equal(result.searchId, "s_123");
      assert.equal(result.cost.creditsCharged, 100);
    });

    it("throws PriorApiError on 402 insufficient credits", async () => {
      routes["POST /v1/knowledge/search"] = (req, res) => {
        jsonResponse(res, 402, {
          ok: false,
          error: { code: "insufficient_credits", message: "Not enough credits", action: "buy_credits" },
        });
      };

      await assert.rejects(() => client.search({ query: "test", context: { runtime: "node" } }), (err) => {
        assert.ok(err instanceof PriorApiError);
        assert.equal(err.code, "insufficient_credits");
        assert.equal(err.action, "buy_credits");
        return true;
      });
    });

    it("throws PriorApiError on 401 invalid key", async () => {
      routes["POST /v1/knowledge/search"] = (req, res) => {
        jsonResponse(res, 401, { ok: false, error: { code: "unauthorized", message: "Invalid API key" } });
      };

      await assert.rejects(() => client.search({ query: "test", context: { runtime: "node" } }), (err) => {
        assert.ok(err instanceof PriorApiError);
        assert.equal(err.code, "unauthorized");
        return true;
      });
    });

    it("returns empty results array when no matches", async () => {
      routes["POST /v1/knowledge/search"] = (req, res) => {
        jsonResponse(res, 200, {
          ok: true,
          data: { results: [], searchId: "s_empty", cost: { creditsCharged: 100, balanceRemaining: 9900 } },
        });
      };

      const result = await client.search({ query: "obscure thing", context: { runtime: "node" } });
      assert.deepEqual(result.results, []);
      assert.equal(result.searchId, "s_empty");
    });

    it("sends correct Authorization header", async () => {
      let capturedAuth;
      routes["POST /v1/knowledge/search"] = (req, res) => {
        capturedAuth = req.headers.authorization;
        jsonResponse(res, 200, { ok: true, data: { results: [], searchId: "s_1", cost: { creditsCharged: 0, balanceRemaining: 0 } } });
      };

      await client.search({ query: "test", context: { runtime: "node" } });
      assert.equal(capturedAuth, "Bearer test-key");
    });

    it("sends correct User-Agent header", async () => {
      let capturedUA;
      routes["POST /v1/knowledge/search"] = (req, res) => {
        capturedUA = req.headers["user-agent"];
        jsonResponse(res, 200, { ok: true, data: { results: [], searchId: "s_1", cost: { creditsCharged: 0, balanceRemaining: 0 } } });
      };

      await client.search({ query: "test", context: { runtime: "node" } });
      assert.ok(capturedUA.startsWith("prior-node-sdk/"));
    });

    it("respects custom baseUrl", async () => {
      // Already tested implicitly — client is constructed with mock baseUrl
      let capturedUrl;
      routes["POST /v1/knowledge/search"] = (req, res) => {
        capturedUrl = req.url;
        jsonResponse(res, 200, { ok: true, data: { results: [], searchId: "s_1", cost: { creditsCharged: 0, balanceRemaining: 0 } } });
      };

      await client.search({ query: "test", context: { runtime: "node" } });
      assert.equal(capturedUrl, "/v1/knowledge/search");
    });
  });

  describe("feedback", () => {
    it("sends correct outcome and reason", async () => {
      let capturedBody;
      routes["POST /v1/knowledge/k_abc/feedback"] = (req, res, body) => {
        capturedBody = body;
        jsonResponse(res, 200, { ok: true, data: {} });
      };

      await client.feedback({ entryId: "k_abc", outcome: "useful", notes: "worked great" });
      assert.equal(capturedBody.outcome, "useful");
      assert.equal(capturedBody.notes, "worked great");
      assert.equal(capturedBody.entryId, undefined); // entryId should NOT be in the body
    });

    it("throws on invalid entry id (404)", async () => {
      routes["POST /v1/knowledge/k_bad/feedback"] = (req, res) => {
        jsonResponse(res, 404, { ok: false, error: { code: "not_found", message: "Entry not found" } });
      };

      await assert.rejects(() => client.feedback({ entryId: "k_bad", outcome: "useful" }), (err) => {
        assert.ok(err instanceof PriorApiError);
        assert.equal(err.code, "not_found");
        return true;
      });
    });
  });

  describe("contribute", () => {
    it("returns entry id on success", async () => {
      routes["POST /v1/knowledge/contribute"] = (req, res) => {
        jsonResponse(res, 201, { ok: true, data: { id: "k_new123" } });
      };

      const result = await client.contribute({ title: "Fix", content: "Solution", tags: ["node"] });
      assert.equal(result.id, "k_new123");
    });

    it("throws on content safety rejection", async () => {
      routes["POST /v1/knowledge/contribute"] = (req, res) => {
        jsonResponse(res, 422, {
          ok: false,
          error: { code: "content_rejected", message: "Content flagged by safety scanner" },
        });
      };

      await assert.rejects(() => client.contribute({ title: "Bad", content: "Bad stuff" }), (err) => {
        assert.ok(err instanceof PriorApiError);
        assert.equal(err.code, "content_rejected");
        return true;
      });
    });
  });

  describe("status", () => {
    it("returns agent info", async () => {
      routes["GET /v1/agents/me"] = (req, res) => {
        jsonResponse(res, 200, {
          ok: true,
          data: { agentId: "ag_test", agentName: "Test Agent", credits: 5000, tier: "free", isActive: true },
        });
      };

      const result = await client.status();
      assert.equal(result.agentId, "ag_test");
      assert.equal(result.credits, 5000);
      assert.equal(result.isActive, true);
    });

    it("throws on invalid key", async () => {
      routes["GET /v1/agents/me"] = (req, res) => {
        jsonResponse(res, 401, { ok: false, error: { code: "unauthorized", message: "Invalid API key" } });
      };

      await assert.rejects(() => client.status(), (err) => {
        assert.ok(err instanceof PriorApiError);
        assert.equal(err.code, "unauthorized");
        return true;
      });
    });
  });

  describe("PriorApiError", () => {
    it("includes code and message from API response", () => {
      const err = new PriorApiError("test_code", "Test message", "do_something", "Try this");
      assert.equal(err.code, "test_code");
      assert.equal(err.message, "Test message");
      assert.equal(err.action, "do_something");
      assert.equal(err.agentHint, "Try this");
      assert.equal(err.name, "PriorApiError");
      assert.ok(err instanceof Error);
    });
  });
});
