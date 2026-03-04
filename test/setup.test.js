// Tests for prior setup command
// Node 18+ built-in test runner, zero dependencies
"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const os = require("os");

// Prior-specific exports
const {
  buildMcpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installRules,
  uninstallRules,
  parseRulesVersion,
  PRIOR_MARKER_RE,
  PRIOR_BLOCK_RE,
  getBundledRules,
  getInstructions,
  sendSetupReport,
} = require("../bin/setup.js");

// Equip primitives (platform detection, MCP config, etc.)
const {
  installMcpJson: _installMcpJson,
  createManualPlatform,
  cli: { sanitizeError },
} = require("@cg3/equip");
const { getVsCodeMcpPath, getVsCodeUserDir, getClineConfigPath, getRooConfigPath } = require("@cg3/equip/platforms");

// Bind "prior" as server name to match old API
const installMcpJson = (platform, mcpEntry, dryRun) => _installMcpJson(platform, "prior", mcpEntry, dryRun);

// ─── Mock Helpers ─────────────────────────────────────────────

function mockPlatform(overrides = {}) {
  return {
    platform: "claude-code",
    version: "1.0.34",
    configPath: path.join(os.tmpdir(), `prior-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
    rulesPath: path.join(os.tmpdir(), `prior-test-rules-${Date.now()}-${Math.random().toString(36).slice(2)}.md`),
    skillDir: null,
    hasCli: false,
    existingMcp: null,
    rootKey: "mcpServers",
    ...overrides,
  };
}

const fs = require("fs");

function cleanupFile(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + ".bak"); } catch {}
}

// ─── Config Generation ───────────────────────────────────────

describe("MCP config generation", () => {
  it("generates correct HTTP config with auth (Claude Code)", () => {
    const config = buildHttpConfigWithAuth("ask_test123", "claude-code");
    assert.deepStrictEqual(config, {
      url: "https://api.cg3.io/mcp",
      headers: { Authorization: "Bearer ask_test123" },
    });
  });

  it("generates correct HTTP config with auth (Cursor uses type: streamable-http)", () => {
    const config = buildHttpConfigWithAuth("ask_test123", "cursor");
    assert.deepStrictEqual(config, {
      type: "streamable-http",
      url: "https://api.cg3.io/mcp",
      headers: { Authorization: "Bearer ask_test123" },
    });
  });

  it("generates correct HTTP config with auth (Windsurf uses serverUrl)", () => {
    const config = buildHttpConfigWithAuth("ask_test123", "windsurf");
    assert.deepStrictEqual(config, {
      serverUrl: "https://api.cg3.io/mcp",
      headers: { Authorization: "Bearer ask_test123" },
    });
  });

  it("generates correct stdio config (non-Windows)", () => {
    const config = buildStdioConfig("ask_test123");
    if (process.platform === "win32") {
      assert.equal(config.command, "cmd");
      assert.deepStrictEqual(config.args, ["/c", "npx", "-y", "@cg3/prior-mcp"]);
    } else {
      assert.equal(config.command, "npx");
      assert.deepStrictEqual(config.args, ["-y", "@cg3/prior-mcp"]);
    }
    assert.deepStrictEqual(config.env, { PRIOR_API_KEY: "ask_test123" });
  });

  it("buildMcpConfig selects http by default", () => {
    const config = buildMcpConfig("ask_test", "http", "claude-code");
    assert.equal(config.url, "https://api.cg3.io/mcp");
    assert.ok(config.headers);
  });

  it("buildMcpConfig selects stdio", () => {
    const config = buildMcpConfig("ask_test", "stdio");
    assert.ok(config.command);
    assert.ok(config.env);
  });
});

// ─── MCP JSON Installation ───────────────────────────────────

describe("MCP JSON installation", () => {
  it("creates new config file when none exists", () => {
    const p = mockPlatform();
    cleanupFile(p.configPath);
    const result = installMcpJson(p, buildHttpConfigWithAuth("ask_test"), false);
    assert.ok(result.success);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior);
    assert.equal(written.mcpServers.prior.url, "https://api.cg3.io/mcp");
    cleanupFile(p.configPath);
  });

  it("merges into existing config without clobbering", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({
      mcpServers: { other: { url: "https://example.com" } },
    }));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior);
    assert.ok(written.mcpServers.other, "other server should be preserved");
    cleanupFile(p.configPath);
  });

  it("updates existing prior entry", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({
      mcpServers: { prior: { url: "https://old.example.com" } },
    }));
    installMcpJson(p, buildHttpConfigWithAuth("ask_new"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.equal(written.mcpServers.prior.headers.Authorization, "Bearer ask_new");
    cleanupFile(p.configPath);
  });

  it("creates backup before writing", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, '{"existing": true}');
    installMcpJson(p, buildHttpConfigWithAuth("ask_test"), false);
    assert.ok(fs.existsSync(p.configPath + ".bak"), "backup should exist");
    cleanupFile(p.configPath);
  });

  it("handles empty/invalid existing file", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, "not json");
    installMcpJson(p, buildHttpConfigWithAuth("ask_test"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior);
    cleanupFile(p.configPath);
  });

  it("dry run does not write", () => {
    const p = mockPlatform();
    cleanupFile(p.configPath);
    installMcpJson(p, buildHttpConfigWithAuth("ask_test"), true);
    assert.ok(!fs.existsSync(p.configPath), "file should not exist after dry run");
  });

  it("handles UTF-8 BOM in existing config file", () => {
    const p = mockPlatform();
    const BOM = "\uFEFF";
    const existing = { mcpServers: { github: { url: "https://github.com/mcp" } } };
    fs.writeFileSync(p.configPath, BOM + JSON.stringify(existing));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "claude-code"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior, "prior should be added");
    assert.ok(written.mcpServers.github, "github should be preserved despite BOM");
    assert.equal(written.mcpServers.github.url, "https://github.com/mcp");
    cleanupFile(p.configPath);
  });

  it("preserves multiple existing servers across platforms", () => {
    // Cursor-like config with multiple servers
    const p = mockPlatform({ platform: "cursor" });
    const existing = {
      mcpServers: {
        github: { url: "https://api.githubcopilot.com/mcp/" },
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        sentry: { url: "https://mcp.sentry.dev/sse" },
      },
    };
    fs.writeFileSync(p.configPath, JSON.stringify(existing));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "cursor"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.equal(Object.keys(written.mcpServers).length, 4, "should have 4 servers total");
    assert.ok(written.mcpServers.github, "github preserved");
    assert.ok(written.mcpServers.filesystem, "filesystem preserved");
    assert.ok(written.mcpServers.sentry, "sentry preserved");
    assert.ok(written.mcpServers.prior, "prior added");
    cleanupFile(p.configPath);
  });

  it("Windsurf config uses serverUrl not url", () => {
    const p = mockPlatform({ platform: "windsurf" });
    const existing = {
      mcpServers: { notion: { serverUrl: "https://mcp.notion.com/mcp" } },
    };
    fs.writeFileSync(p.configPath, JSON.stringify(existing));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "windsurf"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior.serverUrl, "prior should use serverUrl for Windsurf");
    assert.ok(!written.mcpServers.prior.url, "prior should NOT have url for Windsurf");
    assert.ok(written.mcpServers.notion, "notion preserved");
    cleanupFile(p.configPath);
  });

  it("preserves non-MCP fields in Claude Code config", () => {
    const p = mockPlatform();
    const existing = {
      numStartups: 42,
      autoUpdaterStatus: "enabled",
      hasCompletedOnboarding: true,
      projects: { "/some/path": { allowedTools: [] } },
      mcpServers: { existing: { url: "https://example.com" } },
    };
    fs.writeFileSync(p.configPath, JSON.stringify(existing));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "claude-code"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.equal(written.numStartups, 42, "numStartups preserved");
    assert.equal(written.autoUpdaterStatus, "enabled", "autoUpdaterStatus preserved");
    assert.equal(written.hasCompletedOnboarding, true, "onboarding preserved");
    assert.ok(written.projects, "projects preserved");
    assert.ok(written.mcpServers.existing, "existing server preserved");
    assert.ok(written.mcpServers.prior, "prior added");
    cleanupFile(p.configPath);
  });
});

// ─── Rules Installation ──────────────────────────────────────

describe("Behavioral rules installation", () => {
  const rules = getBundledRules();
  const version = parseRulesVersion(rules);

  it("bundled rules have version marker", () => {
    assert.ok(version, "should parse version from bundled rules");
    assert.match(version, /^\d+\.\d+\.\d+$/);
  });

  it("creates new rules file when none exists", () => {
    const p = mockPlatform();
    cleanupFile(p.rulesPath);
    const result = installRules(p, rules, version, false);
    assert.equal(result.action, "created");
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("prior:v"));
    assert.ok(content.includes("ALWAYS search Prior"));
    cleanupFile(p.rulesPath);
  });

  it("appends to existing rules file", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, "# Existing Rules\n\nDo good work.\n");
    const result = installRules(p, rules, version, false);
    assert.equal(result.action, "created");
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes("# Existing Rules"));
    assert.ok(content.includes("ALWAYS search Prior"));
    cleanupFile(p.rulesPath);
  });

  it("skips if same version already present", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, rules);
    const result = installRules(p, rules, version, false);
    assert.equal(result.action, "skipped");
    cleanupFile(p.rulesPath);
  });

  it("updates if older version present", () => {
    const p = mockPlatform();
    const oldRules = rules.replace(`prior:v${version}`, "prior:v0.1.0");
    fs.writeFileSync(p.rulesPath, "# Header\n\n" + oldRules + "\n\n# Footer\n");
    const result = installRules(p, rules, version, false);
    assert.equal(result.action, "updated");
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(content.includes(`prior:v${version}`));
    assert.ok(!content.includes("prior:v0.1.0"));
    assert.ok(content.includes("# Header"));
    assert.ok(content.includes("# Footer"));
    cleanupFile(p.rulesPath);
  });

  it("returns clipboard for Cursor", () => {
    const p = mockPlatform({ platform: "cursor", rulesPath: null });
    const result = installRules(p, rules, version, true);
    assert.equal(result.action, "clipboard");
  });

  it("dry run does not write", () => {
    const p = mockPlatform();
    cleanupFile(p.rulesPath);
    installRules(p, rules, version, true);
    assert.ok(!fs.existsSync(p.rulesPath));
  });
});

// ─── Rules Uninstall ─────────────────────────────────────────

describe("Rules uninstall", () => {
  const rules = getBundledRules();

  it("removes Prior block from rules file", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, "# Header\n\n" + rules + "\n\n# Footer\n");
    const removed = uninstallRules(p, false);
    assert.ok(removed);
    const content = fs.readFileSync(p.rulesPath, "utf-8");
    assert.ok(!content.includes("prior:v"));
    assert.ok(content.includes("# Header"));
    assert.ok(content.includes("# Footer"));
    cleanupFile(p.rulesPath);
  });

  it("deletes file if only Prior content", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, rules);
    const removed = uninstallRules(p, false);
    assert.ok(removed);
    assert.ok(!fs.existsSync(p.rulesPath));
  });

  it("returns false if no Prior content", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.rulesPath, "# No Prior here\n");
    const removed = uninstallRules(p, false);
    assert.ok(!removed);
    cleanupFile(p.rulesPath);
  });
});

// ─── Version Parsing ─────────────────────────────────────────

describe("Version marker parsing", () => {
  it("parses version from marker", () => {
    assert.equal(parseRulesVersion("<!-- prior:v0.5.3 -->"), "0.5.3");
    assert.equal(parseRulesVersion("<!-- prior:v1.0.0 -->"), "1.0.0");
  });

  it("returns null for no marker", () => {
    assert.equal(parseRulesVersion("no marker here"), null);
    assert.equal(parseRulesVersion(""), null);
  });
});

// ─── Manual Platform ─────────────────────────────────────────

describe("Manual platform creation", () => {
  it("creates claude-code platform", () => {
    const p = createManualPlatform("claude-code");
    assert.equal(p.platform, "claude-code");
    assert.ok(p.configPath.includes(".claude.json"));
    assert.ok(p.rulesPath.includes("CLAUDE.md"));
  });

  it("creates cursor platform", () => {
    const p = createManualPlatform("cursor");
    assert.equal(p.platform, "cursor");
    assert.equal(p.rulesPath, null);
  });

  it("creates windsurf platform", () => {
    const p = createManualPlatform("windsurf");
    assert.equal(p.platform, "windsurf");
    assert.ok(p.rulesPath.includes("global_rules.md"));
  });

  it("throws for unknown platform", () => {
    assert.throws(() => createManualPlatform("notepad"), /Unknown platform/);
  });
});

// ─── Sanitize Error ──────────────────────────────────────────

describe("Error sanitization", () => {
  it("replaces home dir with ~", () => {
    const home = os.homedir();
    assert.equal(sanitizeError(`EACCES: ${home}/.cursor/mcp.json`), "EACCES: ~/.cursor/mcp.json");
  });

  it("leaves non-path errors alone", () => {
    assert.equal(sanitizeError("Connection refused"), "Connection refused");
  });
});

// ─── Regex Patterns ──────────────────────────────────────────

describe("Regex patterns", () => {
  it("PRIOR_MARKER_RE matches version markers", () => {
    assert.ok(PRIOR_MARKER_RE.test("<!-- prior:v0.5.3 -->"));
    assert.ok(PRIOR_MARKER_RE.test("<!-- prior:v1.0.0 -->"));
    assert.ok(!PRIOR_MARKER_RE.test("prior v0.5.3"));
  });

  it("PRIOR_BLOCK_RE captures full block", () => {
    const text = "before\n<!-- prior:v0.5.3 -->\ncontent\n<!-- /prior -->\nafter";
    const match = text.match(PRIOR_BLOCK_RE);
    assert.ok(match);
    assert.ok(match[0].includes("content"));
    assert.ok(!match[0].includes("before"));
    assert.ok(!match[0].includes("after"));
  });
});

// ─── Platform Detection ──────────────────────────────────────

describe("Platform detection", () => {
  // These are environment-dependent — test what we can
  const { detectPlatforms } = require("@cg3/equip");

  it("returns an array", () => {
    const platforms = detectPlatforms();
    assert.ok(Array.isArray(platforms));
  });

  it("each platform has required fields", () => {
    const platforms = detectPlatforms();
    for (const p of platforms) {
      assert.ok(p.platform, "must have platform id");
      assert.ok(p.configPath, "must have configPath");
      assert.ok(p.rootKey, "must have rootKey");
    }
  });
});

// ─── MCP Uninstall ───────────────────────────────────────────

describe("MCP uninstall", () => {
  const { uninstallMcp: _uninstallMcp } = require("@cg3/equip");
  const uninstallMcp = (platform, dryRun) => _uninstallMcp(platform, "prior", dryRun);

  it("removes prior entry from config", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({
      mcpServers: {
        prior: { url: "https://api.cg3.io/mcp" },
        other: { url: "https://example.com" },
      },
    }));
    const removed = uninstallMcp(p, false);
    assert.ok(removed);
    const data = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(!data.mcpServers.prior, "prior should be removed");
    assert.ok(data.mcpServers.other, "other should remain");
    cleanupFile(p.configPath);
  });

  it("deletes file if empty after removal", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { prior: {} } }));
    uninstallMcp(p, false);
    assert.ok(!fs.existsSync(p.configPath));
  });

  it("returns false if no prior entry", () => {
    const p = mockPlatform();
    fs.writeFileSync(p.configPath, JSON.stringify({ mcpServers: { other: {} } }));
    const removed = uninstallMcp(p, false);
    assert.ok(!removed);
    cleanupFile(p.configPath);
  });

  it("returns false if file doesn't exist", () => {
    const p = mockPlatform();
    cleanupFile(p.configPath);
    const removed = uninstallMcp(p, false);
    assert.ok(!removed);
  });
});

// ─── Phase 2: VS Code, Cline, Roo Code ──────────────────────

describe("VS Code config generation", () => {
  it("generates HTTP config with type field", () => {
    const config = buildHttpConfigWithAuth("ask_test123", "vscode");
    assert.deepStrictEqual(config, {
      type: "http",
      url: "https://api.cg3.io/mcp",
      headers: { Authorization: "Bearer ask_test123" },
    });
  });

  it("uses 'servers' root key (not mcpServers)", () => {
    const p = mockPlatform({ platform: "vscode", rootKey: "servers" });
    cleanupFile(p.configPath);
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "vscode"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.servers, "should use 'servers' root key");
    assert.ok(written.servers.prior, "should have 'prior' entry");
    assert.equal(written.servers.prior.type, "http");
    assert.ok(!written.mcpServers, "should NOT have mcpServers");
    cleanupFile(p.configPath);
  });

  it("merges into existing VS Code config", () => {
    const p = mockPlatform({ platform: "vscode", rootKey: "servers" });
    fs.writeFileSync(p.configPath, JSON.stringify({
      servers: { github: { type: "http", url: "https://github.example.com" } },
    }));
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "vscode"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.servers.prior);
    assert.ok(written.servers.github, "existing server preserved");
    cleanupFile(p.configPath);
  });

  it("createManualPlatform supports vscode", () => {
    const p = createManualPlatform("vscode");
    assert.equal(p.platform, "vscode");
    assert.equal(p.rootKey, "servers");
    assert.ok(p.configPath.includes("mcp.json"));
    assert.equal(p.rulesPath, null);
  });
});

describe("VS Code path helpers", () => {
  it("getVsCodeUserDir returns platform-appropriate path", () => {
    const dir = getVsCodeUserDir();
    assert.ok(dir.includes("Code") && dir.includes("User"), `unexpected path: ${dir}`);
  });

  it("getVsCodeMcpPath returns mcp.json inside user dir", () => {
    const p = getVsCodeMcpPath();
    assert.ok(p.endsWith("mcp.json"));
    assert.ok(p.includes("Code"));
  });
});

describe("Cline config", () => {
  it("uses mcpServers root key", () => {
    const p = mockPlatform({ platform: "cline", rootKey: "mcpServers" });
    cleanupFile(p.configPath);
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "cline"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior);
    assert.equal(written.mcpServers.prior.url, "https://api.cg3.io/mcp");
    cleanupFile(p.configPath);
  });

  it("getClineConfigPath includes globalStorage path", () => {
    const p = getClineConfigPath();
    assert.ok(p.includes("saoudrizwan.claude-dev"), `unexpected: ${p}`);
    assert.ok(p.includes("settings"), `should include settings dir: ${p}`);
    assert.ok(p.endsWith("cline_mcp_settings.json"));
  });

  it("createManualPlatform supports cline", () => {
    const p = createManualPlatform("cline");
    assert.equal(p.platform, "cline");
    assert.equal(p.rootKey, "mcpServers");
    assert.ok(p.rulesPath.includes("Cline"));
    assert.ok(p.rulesPath.includes("Rules"));
  });

  it("installs rules as standalone file", () => {
    const rulesDir = path.join(os.tmpdir(), `prior-cline-rules-${Date.now()}`);
    const p = mockPlatform({ platform: "cline", rulesPath: rulesDir });
    const rules = getBundledRules();
    const result = installRules(p, rules, "0.5.3", false);
    assert.equal(result.action, "created");
    const content = fs.readFileSync(path.join(rulesDir, "prior.md"), "utf-8");
    assert.ok(PRIOR_MARKER_RE.test(content));
    // Cleanup
    try { fs.unlinkSync(path.join(rulesDir, "prior.md")); fs.rmdirSync(rulesDir); } catch {}
  });
});

describe("Roo Code config", () => {
  it("uses mcpServers root key", () => {
    const p = mockPlatform({ platform: "roo-code", rootKey: "mcpServers" });
    cleanupFile(p.configPath);
    installMcpJson(p, buildHttpConfigWithAuth("ask_test", "roo-code"), false);
    const written = JSON.parse(fs.readFileSync(p.configPath, "utf-8"));
    assert.ok(written.mcpServers.prior);
    cleanupFile(p.configPath);
  });

  it("getRooConfigPath includes globalStorage path", () => {
    const p = getRooConfigPath();
    assert.ok(p.includes("rooveterinaryinc.roo-cline"), `unexpected: ${p}`);
    assert.ok(p.endsWith("cline_mcp_settings.json"));
  });

  it("createManualPlatform supports roo-code", () => {
    const p = createManualPlatform("roo-code");
    assert.equal(p.platform, "roo-code");
    assert.equal(p.rootKey, "mcpServers");
    assert.ok(p.rulesPath.includes(".roo"));
    assert.ok(p.rulesPath.includes("rules"));
  });

  it("installs rules as standalone file", () => {
    const rulesDir = path.join(os.tmpdir(), `prior-roo-rules-${Date.now()}`);
    const p = mockPlatform({ platform: "roo-code", rulesPath: rulesDir });
    const rules = getBundledRules();
    const result = installRules(p, rules, "0.5.3", false);
    assert.equal(result.action, "created");
    const content = fs.readFileSync(path.join(rulesDir, "prior.md"), "utf-8");
    assert.ok(PRIOR_MARKER_RE.test(content));
    try { fs.unlinkSync(path.join(rulesDir, "prior.md")); fs.rmdirSync(rulesDir); } catch {}
  });
});

describe("VS Code rules (clipboard)", () => {
  it("returns clipboard action for VS Code", () => {
    const p = mockPlatform({ platform: "vscode", rulesPath: null });
    const rules = getBundledRules();
    const result = installRules(p, rules, "0.5.3", true);
    assert.equal(result.action, "clipboard");
  });
});

// ─── Remote Instructions ─────────────────────────────────────

describe("getInstructions", () => {
  it("returns fetched data when API is available", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        data: { version: "0.6.0", text: "# Remote instructions\n<!-- prior:v0.6.0 -->\ncontent\n<!-- /prior -->" },
      }),
    });
    try {
      const result = await getInstructions("https://api.cg3.io");
      assert.equal(result.version, "0.6.0");
      assert.ok(result.text.includes("Remote instructions"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to bundled when fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network error"); };
    try {
      const result = await getInstructions("https://api.cg3.io");
      assert.ok(result.version, "should have a version from bundled rules");
      assert.ok(result.text.includes("Prior"), "should contain bundled rules content");
      assert.equal(result.version, parseRulesVersion(getBundledRules()));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to bundled when API returns non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    try {
      const result = await getInstructions("https://api.cg3.io");
      assert.equal(result.version, parseRulesVersion(getBundledRules()));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to bundled when API returns unexpected shape", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ ok: false }),
    });
    try {
      const result = await getInstructions("https://api.cg3.io");
      assert.equal(result.version, parseRulesVersion(getBundledRules()));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Setup report includes instructionsVersion", () => {
  it("sendSetupReport sends instructionsVersion in payload", async () => {
    let capturedBody = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (url.includes("setup-report")) {
        capturedBody = JSON.parse(opts.body);
      }
      return { ok: true };
    };
    try {
      await sendSetupReport("ask_test", "https://api.cg3.io", "1.0.0", [], "0.6.0");
      assert.ok(capturedBody, "fetch should have been called");
      assert.equal(capturedBody.instructionsVersion, "0.6.0");
      assert.equal(capturedBody.cliVersion, "1.0.0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
