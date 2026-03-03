// Platform detection — discovers installed AI coding tools.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { getVsCodeMcpPath, getVsCodeUserDir, getClineConfigPath, getRooConfigPath } = require("./platforms");
const { readMcpEntry } = require("./mcp");

// ─── Helpers ─────────────────────────────────────────────────

function whichSync(cmd) {
  try {
    const r = execSync(process.platform === "win32" ? `where ${cmd} 2>nul` : `which ${cmd} 2>/dev/null`, { encoding: "utf-8", timeout: 5000 });
    return r.trim().split(/\r?\n/)[0] || null;
  } catch { return null; }
}

function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function cliVersion(cmd, regex) {
  try {
    const out = execSync(`${cmd} --version 2>&1`, { encoding: "utf-8", timeout: 5000 });
    const m = out.match(regex || /(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

function getClaudeCodeVersion() {
  try {
    const out = execSync("claude --version 2>&1", { encoding: "utf-8", timeout: 5000 });
    const m = out.match(/(\d+\.\d+[\.\d]*)/);
    return m ? m[1] : "unknown";
  } catch { return null; }
}

// ─── Detection ──────────────────────────────────────────────

/**
 * Detect installed AI coding platforms.
 * @param {string} [serverName] - MCP server name to check for existing config (default: null)
 * @returns {Array<object>} Array of platform objects
 */
function detectPlatforms(serverName) {
  const home = os.homedir();
  const platforms = [];

  // Claude Code
  const claudeVersion = whichSync("claude") ? getClaudeCodeVersion() : null;
  if (claudeVersion || dirExists(path.join(home, ".claude"))) {
    const configPath = path.join(home, ".claude.json");
    const rulesPath = path.join(home, ".claude", "CLAUDE.md");
    platforms.push({
      platform: "claude-code",
      version: claudeVersion || "unknown",
      configPath,
      rulesPath,
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("claude"),
      rootKey: "mcpServers",
    });
  }

  // Cursor
  const cursorDir = path.join(home, ".cursor");
  if (whichSync("cursor") || dirExists(cursorDir)) {
    const configPath = path.join(cursorDir, "mcp.json");
    platforms.push({
      platform: "cursor",
      version: cliVersion("cursor") || "unknown",
      configPath,
      rulesPath: null, // Cursor: clipboard only
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: !!whichSync("cursor"),
      rootKey: "mcpServers",
    });
  }

  // Windsurf
  const windsurfDir = path.join(home, ".codeium", "windsurf");
  if (dirExists(windsurfDir)) {
    const configPath = path.join(windsurfDir, "mcp_config.json");
    const rulesPath = path.join(windsurfDir, "memories", "global_rules.md");
    platforms.push({
      platform: "windsurf",
      version: "unknown",
      configPath,
      rulesPath,
      existingMcp: serverName ? readMcpEntry(configPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
    });
  }

  // VS Code (Copilot)
  const vscodeMcpPath = getVsCodeMcpPath();
  if (whichSync("code") || fileExists(vscodeMcpPath) || dirExists(getVsCodeUserDir())) {
    platforms.push({
      platform: "vscode",
      version: cliVersion("code") || "unknown",
      configPath: vscodeMcpPath,
      rulesPath: null, // VS Code: clipboard only
      existingMcp: serverName ? readMcpEntry(vscodeMcpPath, "servers", serverName) : null,
      hasCli: !!whichSync("code"),
      rootKey: "servers",
    });
  }

  // Cline (VS Code extension)
  const clineConfigPath = getClineConfigPath();
  if (fileExists(clineConfigPath) || dirExists(path.dirname(clineConfigPath))) {
    const home_ = os.homedir();
    platforms.push({
      platform: "cline",
      version: "unknown",
      configPath: clineConfigPath,
      rulesPath: path.join(home_, "Documents", "Cline", "Rules"),
      existingMcp: serverName ? readMcpEntry(clineConfigPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
    });
  }

  // Roo Code (VS Code extension)
  const rooConfigPath = getRooConfigPath();
  if (fileExists(rooConfigPath) || dirExists(path.dirname(rooConfigPath))) {
    platforms.push({
      platform: "roo-code",
      version: "unknown",
      configPath: rooConfigPath,
      rulesPath: path.join(os.homedir(), ".roo", "rules"),
      existingMcp: serverName ? readMcpEntry(rooConfigPath, "mcpServers", serverName) : null,
      hasCli: false,
      rootKey: "mcpServers",
    });
  }

  return platforms;
}

module.exports = {
  detectPlatforms,
  whichSync,
  dirExists,
  fileExists,
  cliVersion,
};
