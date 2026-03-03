// Behavioral rules installation — marker-based versioned blocks.
// Handles appending, updating, and removing rules from shared files.
// Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");

// ─── Constants ──────────────────────────────────────────────

/**
 * Create regex patterns for a given marker name.
 * @param {string} marker - Marker name (e.g., "prior")
 * @returns {{ MARKER_RE: RegExp, BLOCK_RE: RegExp }}
 */
function markerPatterns(marker) {
  return {
    MARKER_RE: new RegExp(`<!-- ${marker}:v[\\d.]+ -->`),
    BLOCK_RE: new RegExp(`<!-- ${marker}:v[\\d.]+ -->[\\s\\S]*?<!-- \\/${marker} -->\\n?`),
  };
}

/**
 * Parse version from marker in content.
 * @param {string} content
 * @param {string} marker
 * @returns {string|null}
 */
function parseRulesVersion(content, marker) {
  const m = content.match(new RegExp(`<!-- ${marker}:v([\\d.]+) -->`));
  return m ? m[1] : null;
}

// ─── Install ─────────────────────────────────────────────────

/**
 * Install behavioral rules to a platform's rules file.
 * Supports: file-based (append/update), standalone file, or clipboard.
 *
 * @param {object} platform - Platform object with rulesPath
 * @param {object} options
 * @param {string} options.content - Rules content (with markers)
 * @param {string} options.version - Current version string
 * @param {string} options.marker - Marker name for tracking
 * @param {string} [options.fileName] - For standalone file platforms (e.g., "prior.md")
 * @param {string[]} [options.clipboardPlatforms] - Platform ids that use clipboard
 * @param {boolean} [options.dryRun]
 * @param {Function} [options.copyToClipboard] - Clipboard function
 * @returns {{ action: string }} "created" | "updated" | "skipped" | "clipboard"
 */
function installRules(platform, options) {
  const {
    content,
    version,
    marker,
    fileName,
    clipboardPlatforms = ["cursor", "vscode"],
    dryRun = false,
    copyToClipboard,
  } = options;

  // Clipboard-only platforms
  if (clipboardPlatforms.includes(platform.platform)) {
    if (!dryRun && copyToClipboard) {
      copyToClipboard(content);
    }
    return { action: "clipboard" };
  }

  if (!platform.rulesPath) return { action: "skipped" };

  // Determine actual file path — standalone file (directory-based) vs append (file-based)
  // Only use fileName if rulesPath is a directory (or doesn't exist yet as a file)
  let rulesPath;
  if (fileName) {
    try {
      const stat = fs.statSync(platform.rulesPath);
      rulesPath = stat.isDirectory() ? path.join(platform.rulesPath, fileName) : platform.rulesPath;
    } catch {
      // Path doesn't exist — check if it looks like a file (has extension) or directory
      rulesPath = path.extname(platform.rulesPath) ? platform.rulesPath : path.join(platform.rulesPath, fileName);
    }
  } else {
    rulesPath = platform.rulesPath;
  }

  const { MARKER_RE, BLOCK_RE } = markerPatterns(marker);

  let existing = "";
  try { existing = fs.readFileSync(rulesPath, "utf-8"); } catch {}

  const existingVersion = parseRulesVersion(existing, marker);

  if (existingVersion === version) {
    return { action: "skipped" };
  }

  if (!dryRun) {
    const dir = path.dirname(rulesPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (existingVersion) {
      // Replace existing block
      const updated = existing.replace(BLOCK_RE, content + "\n");
      fs.writeFileSync(rulesPath, updated);
      return { action: "updated" };
    }

    // Append
    const sep = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
    fs.writeFileSync(rulesPath, existing + sep + content + "\n");
    return { action: "created" };
  }

  return { action: existingVersion ? "updated" : "created" };
}

/**
 * Remove rules from a platform's rules file.
 * @param {object} platform - Platform object
 * @param {object} options
 * @param {string} options.marker - Marker name
 * @param {string} [options.fileName] - For standalone file platforms
 * @param {boolean} [options.dryRun]
 * @returns {boolean} Whether anything was removed
 */
function uninstallRules(platform, options) {
  const { marker, fileName, dryRun = false } = options;

  if (!platform.rulesPath) return false;

  let rulesPath;
  if (fileName) {
    try {
      const stat = fs.statSync(platform.rulesPath);
      rulesPath = stat.isDirectory() ? path.join(platform.rulesPath, fileName) : platform.rulesPath;
    } catch {
      rulesPath = path.extname(platform.rulesPath) ? platform.rulesPath : path.join(platform.rulesPath, fileName);
    }
  } else {
    rulesPath = platform.rulesPath;
  }

  try {
    if (!fs.statSync(rulesPath).isFile()) return false;
  } catch { return false; }

  try {
    const content = fs.readFileSync(rulesPath, "utf-8");
    const { MARKER_RE, BLOCK_RE } = markerPatterns(marker);
    if (!MARKER_RE.test(content)) return false;
    if (!dryRun) {
      const cleaned = content.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n").trim();
      if (cleaned) {
        fs.writeFileSync(rulesPath, cleaned + "\n");
      } else {
        fs.unlinkSync(rulesPath);
      }
    }
    return true;
  } catch { return false; }
}

module.exports = {
  markerPatterns,
  parseRulesVersion,
  installRules,
  uninstallRules,
};
