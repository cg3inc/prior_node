// MCP config read/write/merge/uninstall.
// Handles all platform-specific config format differences.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ─── Read ────────────────────────────────────────────────────

/**
 * Read an MCP server entry from a config file.
 * @param {string} configPath - Path to config JSON file
 * @param {string} rootKey - Root key ("mcpServers" or "servers")
 * @param {string} serverName - Server name to read
 * @returns {object|null} Server config or null
 */
function readMcpEntry(configPath, rootKey, serverName) {
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // Strip BOM
    const data = JSON.parse(raw);
    return data?.[rootKey]?.[serverName] || null;
  } catch { return null; }
}

// ─── Config Builders ─────────────────────────────────────────

/**
 * Build HTTP MCP config for a platform.
 * Handles platform-specific field names (url vs serverUrl, type field).
 * @param {string} serverUrl - MCP server URL
 * @param {string} platform - Platform id
 * @returns {object} MCP config object
 */
function buildHttpConfig(serverUrl, platform) {
  if (platform === "windsurf") return { serverUrl };
  if (platform === "vscode") return { type: "http", url: serverUrl };
  return { url: serverUrl };
}

/**
 * Build HTTP MCP config with auth headers.
 * @param {string} serverUrl - MCP server URL
 * @param {string} apiKey - API key for auth
 * @param {string} platform - Platform id
 * @param {object} [extraHeaders] - Additional headers
 * @returns {object} MCP config with headers
 */
function buildHttpConfigWithAuth(serverUrl, apiKey, platform, extraHeaders) {
  return {
    ...buildHttpConfig(serverUrl, platform),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
  };
}

/**
 * Build stdio MCP config.
 * @param {string} command - Command to run
 * @param {string[]} args - Command arguments
 * @param {object} env - Environment variables
 * @returns {object} MCP stdio config
 */
function buildStdioConfig(command, args, env) {
  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", command, ...args], env };
  }
  return { command, args, env };
}

// ─── Install ─────────────────────────────────────────────────

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Install MCP config for a platform.
 * Tries platform CLI first (if available), falls back to JSON write.
 * @param {object} platform - Platform object from detect
 * @param {string} serverName - Server name (e.g., "prior")
 * @param {object} mcpEntry - MCP config object
 * @param {object} [options] - { dryRun, serverUrl }
 * @returns {{ success: boolean, method: string }}
 */
function installMcp(platform, serverName, mcpEntry, options = {}) {
  const { dryRun = false, serverUrl } = options;

  // Claude Code: try CLI first
  if (platform.platform === "claude-code" && platform.hasCli && mcpEntry.url) {
    try {
      if (!dryRun) {
        const headerArgs = mcpEntry.headers
          ? Object.entries(mcpEntry.headers).map(([k, v]) => `--header "${k}: ${v}"`).join(" ")
          : "";
        execSync(`claude mcp add --transport http -s user ${headerArgs} ${serverName} ${mcpEntry.url}`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // Cursor: try CLI first
  if (platform.platform === "cursor" && platform.hasCli) {
    try {
      const mcpJson = JSON.stringify({ name: serverName, ...mcpEntry });
      if (!dryRun) {
        execSync(`cursor --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // VS Code: try CLI first
  if (platform.platform === "vscode" && platform.hasCli) {
    try {
      const mcpJson = JSON.stringify({ name: serverName, ...mcpEntry });
      if (!dryRun) {
        execSync(`code --add-mcp '${mcpJson.replace(/'/g, "'\\''")}'`, {
          encoding: "utf-8", timeout: 15000, stdio: "pipe",
        });
        const check = readMcpEntry(platform.configPath, platform.rootKey, serverName);
        if (check) return { success: true, method: "cli" };
      } else {
        return { success: true, method: "cli" };
      }
    } catch { /* fall through */ }
  }

  // JSON write (all platforms, fallback for CLI failures)
  return installMcpJson(platform, serverName, mcpEntry, dryRun);
}

/**
 * Write MCP config directly to JSON file.
 * Merges with existing config, creates backup.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name
 * @param {object} mcpEntry - MCP config
 * @param {boolean} dryRun
 * @returns {{ success: boolean, method: string }}
 */
function installMcpJson(platform, serverName, mcpEntry, dryRun) {
  const { configPath, rootKey } = platform;

  let existing = {};
  try {
    let raw = fs.readFileSync(configPath, "utf-8");
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    existing = JSON.parse(raw);
    if (typeof existing !== "object" || existing === null) existing = {};
  } catch { /* start fresh */ }

  if (!existing[rootKey]) existing[rootKey] = {};
  existing[rootKey][serverName] = mcpEntry;

  if (!dryRun) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (fileExists(configPath)) {
      try { fs.copyFileSync(configPath, configPath + ".bak"); } catch {}
    }

    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
  }

  return { success: true, method: "json" };
}

/**
 * Remove an MCP server entry from a platform config.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name to remove
 * @param {boolean} dryRun
 * @returns {boolean} Whether anything was removed
 */
function uninstallMcp(platform, serverName, dryRun) {
  const { configPath, rootKey } = platform;
  if (!fileExists(configPath)) return false;

  try {
    const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!data?.[rootKey]?.[serverName]) return false;
    delete data[rootKey][serverName];
    if (Object.keys(data[rootKey]).length === 0) delete data[rootKey];
    if (!dryRun) {
      fs.copyFileSync(configPath, configPath + ".bak");
      if (Object.keys(data).length === 0) {
        fs.unlinkSync(configPath);
      } else {
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Update API key in existing MCP config.
 * @param {object} platform - Platform object
 * @param {string} serverName - Server name
 * @param {object} mcpEntry - New MCP config
 * @returns {{ success: boolean, method: string }}
 */
function updateMcpKey(platform, serverName, mcpEntry) {
  return installMcpJson(platform, serverName, mcpEntry, false);
}

module.exports = {
  readMcpEntry,
  buildHttpConfig,
  buildHttpConfigWithAuth,
  buildStdioConfig,
  installMcp,
  installMcpJson,
  uninstallMcp,
  updateMcpKey,
};
