// prior setup — One-command installation for AI coding tools.
// Uses @cg3/equip for platform detection, MCP config, and rules management.
// https://prior.cg3.io

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");
const readline = require("readline");

// ─── Equip Integration ───────────────────────────────────────

const {
  Equip,
  parseRulesVersion,
  markerPatterns,
  createManualPlatform,
  platformName,
  resolvePlatformId,
  cli,
} = require("@cg3/equip");

const { log, ok, fail, warn, info, step, prompt, promptEnterOrEsc, copyToClipboard, sanitizeError,
  GREEN, RED, YELLOW, CYAN, BOLD, DIM, RESET } = cli;

// ─── Constants ───────────────────────────────────────────────

const MCP_URL = "https://api.cg3.io/mcp";
const PRIOR_MARKER = "prior";

// ─── Prior-Specific Helpers ──────────────────────────────────

function getBundledRules() {
  const rulesPath = path.join(__dirname, "..", "skills", "condensed.md");
  return fs.readFileSync(rulesPath, "utf-8").trim();
}

function getBundledSkill() {
  const skillPath = path.join(__dirname, "..", "skills", "search", "SKILL.md");
  return fs.readFileSync(skillPath, "utf-8");
}

function getBundledSkillConfig() {
  return {
    name: "search",
    files: [{ path: "SKILL.md", content: getBundledSkill() }],
  };
}

function getRulesVersion() {
  const content = getBundledRules();
  return parseRulesVersion(content, PRIOR_MARKER);
}

// ─── Remote Instructions ─────────────────────────────────────

async function getInstructions(apiUrl) {
  try {
    const res = await fetch(`${apiUrl}/v1/instructions`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const json = await res.json();
      if (json.ok && json.data) return { version: json.data.version, text: json.data.text, source: "api" };
    }
  } catch { /* offline or timeout */ }
  // Fallback: bundled condensed.md
  return { version: getRulesVersion(), text: getBundledRules(), source: "bundled" };
}

// ─── Equip Instance ──────────────────────────────────────────

// ─── Prior Hook Scripts ──────────────────────────────────────

// ─── Claude Code Lifecycle Hooks ─────────────────────────────
// Prior installs a lightweight session metadata tracker as a Claude Code hook.
// The handler script (lib/prior-handler.js) collects tool usage patterns and
// conditionally nudges the agent to search Prior after errors or contribute
// solutions after iterative debugging sessions.
//
// How it works:
//   - Registered for PostToolUse, PostToolUseFailure, and Stop events
//   - Claude Code pipes event JSON to stdin; handler returns additionalContext via stdout
//   - State persists to a temp file across tool calls within a session
//   - Stop event resets per-prompt state while preserving session-level stats
//
// The script is a standalone Node.js file read at install time and written to
// ~/.prior/hooks/ by equip's installHooks(). See lib/prior-handler.js for the
// full implementation.

const PRIOR_HANDLER_SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "lib", "prior-handler.js"), "utf-8"
);

// Hook event registrations — all point to the same handler script.
// equip writes the script once and registers it for each event in
// Claude Code's ~/.claude/settings.json.
const PRIOR_HOOKS = [
  { event: "PostToolUse", name: "prior-handler", script: PRIOR_HANDLER_SCRIPT },
  { event: "PostToolUseFailure", matcher: "Bash", name: "prior-handler", script: PRIOR_HANDLER_SCRIPT },
  { event: "Stop", name: "prior-handler", script: PRIOR_HANDLER_SCRIPT },
];


function createEquip(version, instructions) {
  const rulesContent = instructions ? instructions.text : getBundledRules();
  const rulesVersion = instructions ? instructions.version : (version || getRulesVersion());
  return new Equip({
    name: "prior",
    package: "@cg3/prior-node",
    serverUrl: MCP_URL,
    rules: {
      content: rulesContent,
      version: rulesVersion,
      marker: PRIOR_MARKER,
      fileName: "prior.md",
      clipboardPlatforms: ["cursor", "vscode"],
    },
    stdio: {
      command: "npx",
      args: ["-y", "@cg3/prior-mcp"],
      envKey: "PRIOR_API_KEY",
    },
    hooks: PRIOR_HOOKS,
    skill: getBundledSkillConfig(),
  });
}

// Skill installation is now handled by equip via the `skill` config
// in the Equip constructor. No custom skill code needed.

// ─── Verification ────────────────────────────────────────────

async function verifySetup(platform, equip, apiKey, apiUrl) {
  // Use equip.verify() for MCP, rules, hooks, and skills checks
  const equipResult = equip.verify(platform);
  const results = {
    mcp: equipResult.checks.find(c => c.name === "mcp")?.ok ?? false,
    rules: equipResult.checks.find(c => c.name === "rules")?.ok ?? true, // true if not checked (clipboard platforms)
    skill: equipResult.checks.find(c => c.name === "skills")?.ok ?? true, // true if not checked (no skillsPath)
    hooks: equipResult.checks.find(c => c.name === "hooks")?.ok ?? true, // true if not checked
    api: false,
  };

  // Clipboard platforms — can't verify rules, assume ok
  if (platform.platform === "cursor" || platform.platform === "vscode") {
    results.rules = true;
  }

  // Prior-specific: API connectivity test (equip doesn't do this)
  try {
    const res = await fetch(`${apiUrl}/v1/agents/me`, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "prior-setup" },
    });
    results.api = res.ok;
  } catch {}

  return results;
}

// ─── Setup Report ────────────────────────────────────────────

async function sendSetupReport(apiKey, apiUrl, cliVersion, platformResults, instructionsVersion, extras) {
  try {
    await fetch(`${apiUrl}/v1/agents/setup-report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": `prior-setup/${cliVersion}`,
      },
      body: JSON.stringify({
        cliVersion,
        instructionsVersion: instructionsVersion || undefined,
        os: process.platform,
        nodeVersion: process.version,
        arch: process.arch,
        platforms: platformResults.map(r => ({
          platform: r.platform,
          version: r.version,
          transport: r.transport,
          success: r.success,
          error: r.error ? sanitizeError(r.error) : undefined,
        })),
        ...(extras || {}),
      }),
    });
  } catch { /* Fire and forget */ }
}

// ─── Main Setup Command ──────────────────────────────────────

async function cmdSetup(args, deps) {
  const setupStartTime = Date.now();
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;
  const existingConfig = loadConfig();
  const isFirstRun = !existingConfig || (!existingConfig.apiKey && !existingConfig.tokens);
  const instructions = await getInstructions(API_URL);
  const equip = createEquip(VERSION, instructions);

  if (args.help) {
    log(`prior setup [options]

One-command installation of Prior for AI coding tools.
Detects your environment, authenticates, configures MCP, and installs
behavioral rules so your agents start using Prior automatically.

Options:
  --platform <name>      Target specific platform(s), comma-separated. Aliases: claude, code, roo, gemini, copilot
  --transport http|stdio Transport (default: http)
  --api-key <key>        Use this API key (skips OAuth)
  --api-key-file <path>  Read API key from file (- for stdin)
  --skip-auth            Skip auth (use existing credentials)
  --skip-mcp             Skip MCP server installation
  --skip-rules           Skip behavioral rules installation
  --non-interactive      No prompts (fail if info missing)
  --dry-run              Preview without writing
  --update               Refresh rules, auto-recover auth
  --rekey                Rotate API key, update all configs
  --uninstall            Remove Prior from detected platforms
  --help                 Show this help

Examples:
  prior setup                          # Interactive (recommended)
  prior setup --platform claude         # Specific platform (alias for claude-code)
  prior setup --platform claude,cursor  # Multiple platforms
  prior setup --transport stdio        # Local MCP server
  prior setup --update                 # Refresh everything
  prior setup --rekey                  # Rotate API key
  prior setup --uninstall              # Remove Prior`);
    return;
  }

  const transport = args.transport || "http";
  const dryRun = !!args.dryRun;
  const nonInteractive = !!args.nonInteractive;

  if (dryRun) log(`${DIM}(dry run — no files will be modified)${RESET}`);

  // ── Uninstall Mode ──
  if (args.uninstall) {
    return runUninstall(args, equip, dryRun, VERSION);
  }

  // ── Detection ──
  log(`\n${BOLD}Prior Setup${RESET}\n`);
  log("Detecting environment...");

  let platforms = equip.detect();
  let equipVersion = process.env.EQUIP_VERSION;
  if (!equipVersion) {
    try {
      const equipDir = path.dirname(require.resolve("@cg3/equip"));
      equipVersion = JSON.parse(fs.readFileSync(path.join(equipDir, "package.json"), "utf-8")).version;
    } catch {}
  }

  log(`  OS         ${process.platform} ${os.arch()}`);
  log(`  Node       ${process.version}`);
  if (equipVersion) log(`  Equip      v${equipVersion}`);
  log(`  Prior CLI  v${VERSION}`);

  // Filter by --platform if specified (supports comma-separated values and friendly aliases)
  if (args.platform) {
    const requested = args.platform.split(",").map(s => resolvePlatformId(s));
    const matched = platforms.filter(p => requested.includes(p.platform));
    if (matched.length > 0) {
      platforms = matched;
    } else {
      // None detected — create manual entries for each requested platform
      platforms = requested.map(id => createManualPlatform(id));
    }
  }

  if (platforms.length === 0) {
    fail("No supported AI coding tools detected.");
    log(`\n  Install one of: Claude Code, Cursor, Windsurf, VS Code, Cline, Roo Code, Junie, Copilot CLI`);
    log(`  Or specify manually: prior setup --platform claude-code`);
    process.exit(1);
  }

  const names = platforms.map(p => `${platformName(p.platform)} ${p.version !== "unknown" ? `v${p.version}` : ""}`).join(", ");
  log(`  Detected   ${names.trim()}`);

  // ── Rekey Mode ──
  if (args.rekey) {
    return runRekey(args, deps, equip, platforms, transport, nonInteractive, dryRun);
  }

  // ── Update Mode ──
  if (args.update) {
    return runUpdate(args, deps, equip, platforms, transport, nonInteractive, dryRun);
  }

  // ── Step 1: Authentication ──
  const totalSteps = 5;
  step(1, totalSteps, "Authentication");

  let authMethod = "unknown";
  if (args.apiKey) authMethod = "api_key_flag";
  else if (args.apiKeyFile) authMethod = "api_key_file";
  else if (existingConfig?.apiKey || process.env.PRIOR_API_KEY) authMethod = "existing_key";
  else if (existingConfig?.tokens?.access_token) authMethod = "existing_oauth";
  else authMethod = "oauth_login";

  let apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
  if (!apiKey) {
    fail("Authentication failed");
    log(`    → Run: prior setup --api-key <key>`);
    log(`    → Get a key at: https://prior.cg3.io/account`);
    process.exit(1);
  }

  // Validate the key
  if (dryRun) {
    ok(`API key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)} (skipping validation in dry-run)`);
  } else {
    const whoami = await api("GET", "/v1/agents/me", null, apiKey);
    if (whoami.ok && whoami.data) {
      const email = whoami.data.email;
      const display = email ? email.replace(/^(..)[^@]*/, "$1***") : whoami.data.agentName || whoami.data.id?.slice(0, 8);
      ok(`Authenticated as ${display}`);
    } else {
      fail("API key validation failed");
      log(`    → Key may be invalid or expired`);
      log(`    → Try: prior setup --api-key <new-key>`);
      process.exit(1);
    }
  }

  // ── Step 2: MCP Server ──
  step(2, totalSteps, "MCP Server");
  log(`  Transport  ${transport} ${DIM}${transport === "http" ? "(remote — no local install needed)" : "(local process)"}${RESET}`);

  const platformResults = [];
  for (const p of platforms) {
    if (args.skipMcp) {
      info(`${platformName(p.platform)}   Skipped ${DIM}(--skip-mcp)${RESET}`);
      platformResults.push({ ...p, transport, mcpSuccess: true, mcpMethod: "skipped" });
      continue;
    }

    try {
      const result = equip.installMcp(p, apiKey, { transport, dryRun });
      ok(`${platformName(p.platform)}   MCP server "prior" ${dryRun ? "would be " : ""}added ${DIM}(${transport}, ${result.method})${RESET}`);
      platformResults.push({ ...p, transport, mcpSuccess: true, mcpMethod: result.method });
    } catch (e) {
      fail(`${platformName(p.platform)}   ${e.message}`);
      platformResults.push({ ...p, transport, mcpSuccess: false, error: e.message });
    }
  }

  // ── Step 3: Behavioral Rules ──
  step(3, totalSteps, "Behavioral Rules");

  for (const p of platformResults) {
    if (args.skipRules) {
      info(`${platformName(p.platform)}   Skipped ${DIM}(--skip-rules)${RESET}`);
      continue;
    }

    if (!p.mcpSuccess && p.platform !== "cursor") {
      log(`  ${DIM}— ${platformName(p.platform)}   Skipped (MCP install failed)${RESET}`);
      continue;
    }

    try {
      const rResult = equip.installRules(p, { dryRun });
      if (rResult.action === "clipboard") {
        const copied = !dryRun;
        if (copied) {
          warn(`${platformName(p.platform)}   Instructions copied to clipboard — paste required`);
          if (p.platform === "vscode") {
            log(`    → Create .github/copilot-instructions.md in your project and paste`);
          } else {
            log(`    → Open Cursor > Settings (${process.platform === "darwin" ? "⌘" : "Ctrl"}+,) > Rules > Paste`);
          }
        } else {
          info(`${platformName(p.platform)}   Instructions would be copied to clipboard`);
        }
      } else if (rResult.action === "skipped") {
        ok(`${platformName(p.platform)}   Instructions already up to date`);
      } else {
        const rulesFile = p.rulesPath ? p.rulesPath.replace(os.homedir(), "~").replace(/\\/g, "/") : "rules file";
        ok(`${platformName(p.platform)}   Prior instructions ${instructions.version} appended to ${rulesFile}`);
      }

      p.rulesAction = rResult.action; // Track for setup report

      // Install skill (all platforms with skill support)
      const skillResult = equip.installSkill(p, { dryRun });
      if (skillResult.action === "created") {
        ok(`${platformName(p.platform)}   Skill installed`);
      }
    } catch (e) {
      fail(`${platformName(p.platform)}   ${e.message}`);
    }
  }

  // ── Step 4: Hooks ──
  step(4, totalSteps, "Hooks");
  let hooksInstalled = false;

  for (const p of platformResults) {
    if (!p.mcpSuccess) continue;

    if (equip.supportsHooks(p)) {
      try {
        const hookResult = equip.installHooks(p, { dryRun });
        if (hookResult && hookResult.installed) {
          const uniqueScripts = [...new Set(hookResult.scripts)];
          const events = PRIOR_HOOKS.map(h => h.event);
          ok(`${platformName(p.platform)}   ${events.length} events → ${uniqueScripts[0]} ${dryRun ? "(dry run)" : ""}`);
          events.forEach((ev, i) => {
            const connector = i === events.length - 1 ? "└─" : "├─";
            log(`      ${DIM}${connector}${RESET} ${ev}`);
          });
          hooksInstalled = true;
        }
      } catch (e) {
        fail(`${platformName(p.platform)}   Hooks: ${e.message}`);
      }
    }
    // No output for platforms without hook support (clean install log)
  }

  if (!hooksInstalled && !dryRun) {
    log(`  ${DIM}No platforms with hook support detected${RESET}`);
  }

  // ── Step 5: Verification ──
  step(5, totalSteps, "Verification");

  let allGood = true;
  for (const p of platformResults) {
    if (!p.mcpSuccess) {
      fail(`${platformName(p.platform)}   MCP failed`);
      allGood = false;
      continue;
    }

    if (dryRun) {
      ok(`${platformName(p.platform)}   ${DIM}(dry run — skipping verification)${RESET}`);
      continue;
    }

    const v = await verifySetup(p, equip, apiKey, API_URL);

    const items = [];
    items.push({ label: "MCP config", pass: v.mcp });
    items.push({ label: "Behavioral rules", pass: v.rules });
    if (p.platform === "claude-code" && v.skill) items.push({ label: "Skill files", pass: v.skill });
    if (equip.supportsHooks(p)) items.push({ label: "Hooks", pass: equip.hasHooks(p) });
    items.push({ label: "API connection", pass: v.api });

    if (!v.mcp) allGood = false;
    const allPass = items.every(i => i.pass);

    if (allPass) {
      ok(platformName(p.platform));
    } else if (v.mcp) {
      warn(platformName(p.platform));
    } else {
      fail(platformName(p.platform));
    }
    items.forEach((item, i) => {
      const connector = i === items.length - 1 ? "└─" : "├─";
      const icon = item.pass ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
      log(`      ${DIM}${connector}${RESET} ${icon} ${item.label}`);
    });
    if (!v.mcp) {
      log(`      ${DIM}→ MCP config not found. Try: prior setup --platform ${p.platform}${RESET}`);
    } else if (!v.api) {
      log(`      ${DIM}→ API unreachable — will work once connected${RESET}`);
    }
  }

  // Send setup report (fire and forget)
  if (!dryRun) {
    sendSetupReport(apiKey, API_URL, VERSION, platformResults.map(p => ({
      platform: p.platform,
      version: p.version,
      transport: p.transport,
      success: p.mcpSuccess,
      error: p.error,
      rulesAction: p.rulesAction || undefined,
    })), instructions.version, {
      isFirstRun,
      setupDurationMs: Date.now() - setupStartTime,
      authMethod,
      instructionsSource: instructions.source,
    });
  }

  // ── Summary ──
  log("");
  const succeeded = platformResults.filter(p => p.mcpSuccess);
  const failed = platformResults.filter(p => !p.mcpSuccess);

  if (failed.length === 0) {
    const platList = succeeded.map(p => platformName(p.platform)).join(", ");
    log(`${GREEN}${BOLD}  ✓ Prior ${dryRun ? "would be " : ""}installed for ${platList}${RESET}`);
    log(`\n  Your agents will now search Prior before solving problems`);
    log(`  and may occasionally ask to contribute solutions you've discovered.`);
  } else if (succeeded.length > 0) {
    log(`${YELLOW}${BOLD}  ⚠ Prior partially installed${RESET}`);
    for (const s of succeeded) ok(`${platformName(s.platform)} is ready`);
    for (const f of failed) {
      fail(`${platformName(f.platform)} failed`);
      log(`    → ${f.error}`);
      log(`    → Fix: prior setup --platform ${f.platform}`);
    }
  } else {
    log(`${RED}${BOLD}  ✗ Prior setup failed${RESET}`);
    for (const f of failed) {
      fail(`${f.error}`);
    }
  }

  log(`\n  Dashboard   https://prior.cg3.io`);
  if (succeeded.length > 0) {
    log(`  Commands    prior setup --update | --rekey | --uninstall`);
  }
  log(`  Help        prior@cg3.io`);

  // Platform-specific hints
  if (succeeded.some(p => p.platform === "cursor")) {
    log(`\n  ${DIM}Cursor: If Prior tools aren't available after restart,`);
    log(`  check Settings > MCP and ensure "prior" is enabled.${RESET}`);
  }
  if (succeeded.some(p => p.platform === "vscode")) {
    log(`\n  ${DIM}VS Code: Reload the window (Ctrl+Shift+P → "Reload Window")`);
    log(`  to pick up the new MCP configuration.${RESET}`);
  }

  // Offer to open dashboard
  if (!nonInteractive && !dryRun && succeeded.length > 0) {
    log("");
    const openDashboard = await promptEnterOrEsc(`  Press ${BOLD}Enter${RESET} to open your Prior Dashboard, or ${BOLD}Esc${RESET} to exit: `);
    if (!openDashboard) {
      // User pressed Esc
    } else {
      let dashUrl = "https://prior.cg3.io/account";
      try {
        const codeData = await api("POST", "/v1/agents/cli-code", {}, apiKey);
        if (codeData.ok && codeData.data && codeData.data.code) {
          dashUrl = `https://prior.cg3.io/account?cli_code=${encodeURIComponent(codeData.data.code)}`;
        }
      } catch { /* fall through */ }
      const cp = require("child_process");
      if (process.platform === "win32") {
        cp.execSync(`start "" "${dashUrl}"`, { shell: "cmd.exe", stdio: "ignore" });
      } else if (process.platform === "darwin") {
        cp.spawn("open", [dashUrl], { detached: true, stdio: "ignore" }).unref();
      } else {
        cp.spawn("xdg-open", [dashUrl], { detached: true, stdio: "ignore" }).unref();
      }
    }
  }
}

// ─── Auth Resolution ─────────────────────────────────────────

async function resolveAuth(args, deps, nonInteractive, dryRun) {
  const { loadConfig, saveConfig, api, VERSION, API_URL, readApiKeyFromFile, doOAuthLogin } = deps;

  // 1. --api-key flag
  if (args.apiKey) {
    const key = args.apiKey;
    const config = loadConfig() || {};
    config.apiKey = key;
    if (!dryRun) saveConfig(config);
    return key;
  }

  // 2. --api-key-file flag
  if (args.apiKeyFile) {
    const key = readApiKeyFromFile(args.apiKeyFile);
    const config = loadConfig() || {};
    config.apiKey = key;
    if (!dryRun) saveConfig(config);
    return key;
  }

  // 3. Check existing credentials
  const config = loadConfig();
  const existingKey = process.env.PRIOR_API_KEY || config?.apiKey;
  if (existingKey) {
    const check = await api("GET", "/v1/agents/me", null, existingKey);
    if (check.ok) {
      ok("Existing API key valid");
      return existingKey;
    }
    warn("Existing API key invalid (401)");
  }

  // 3b. Existing OAuth tokens
  if (config?.tokens?.access_token) {
    const refreshed = await deps.refreshTokenIfNeeded?.();
    const jwt = refreshed || config.tokens.access_token;

    const cliKeyRes = await api("POST", "/v1/agents/cli-key", { regenerate: false }, jwt);
    if (cliKeyRes.ok && cliKeyRes.data?.apiKey) {
      const key = cliKeyRes.data.apiKey;
      const cfg = loadConfig() || {};
      cfg.apiKey = key;
      if (!dryRun) saveConfig(cfg);
      ok(`API key obtained for MCP configuration`);
      return key;
    }

    if (cliKeyRes.error?.code === "KEY_EXISTS") {
      if (nonInteractive) {
        fail("API key exists on server but not locally. Use --api-key to provide it.");
        return null;
      }

      log(`\n  An API key already exists for this account.`);
      log(`    [1] Generate a fresh key (old key will stop working)`);
      log(`    [2] Enter your existing key manually`);
      log(`        → Find at: https://prior.cg3.io/account`);
      const choice = await prompt("  Choice [1]: ");

      if (choice === "2") {
        const manual = await prompt("  Paste your API key: ");
        if (manual) {
          const cfg = loadConfig() || {};
          cfg.apiKey = manual;
          if (!dryRun) saveConfig(cfg);
          return manual;
        }
        return null;
      }

      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, jwt);
      if (regenRes.ok && regenRes.data?.apiKey) {
        const key = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = key;
        if (!dryRun) saveConfig(cfg);
        ok("New API key generated");
        return key;
      }
      fail("Failed to regenerate key: " + (regenRes.error?.message || "unknown error"));
      return null;
    }
  }

  // 4. --skip-auth
  if (args.skipAuth) {
    fail("No valid credentials found. Cannot skip auth.");
    return null;
  }

  // 5. Non-interactive
  if (nonInteractive) {
    fail("No credentials found. Use --api-key or --api-key-file.");
    return null;
  }

  // 6. Interactive OAuth
  log(`\n  No Prior credentials found.`);
  log(`    [1] Log in with browser (GitHub/Google) — recommended`);
  log(`    [2] Enter API key manually`);
  const choice = await prompt("  Choice [1]: ");

  if (choice === "2") {
    const manual = await prompt("  Paste your API key: ");
    if (manual) {
      const cfg = loadConfig() || {};
      cfg.apiKey = manual;
      if (!dryRun) saveConfig(cfg);
      return manual;
    }
    return null;
  }

  const loginResult = await doOAuthLogin();

  if (loginResult === false) {
    // OAuth timed out — check if we have existing credentials
    const existingConfig = loadConfig();
    if (existingConfig?.apiKey) {
      warn("Login timed out, but found existing credentials.");
      ok(`Authenticated (existing credentials)`);
      return existingConfig.apiKey;
    }
    fail("Login timed out. Try again or use: prior setup --api-key-file <path>");
    return null;
  }

  const postOauthConfig = loadConfig();
  if (postOauthConfig?.tokens?.access_token) {
    const jwt = postOauthConfig.tokens.access_token;
    const cliKeyRes = await api("POST", "/v1/agents/cli-key", { regenerate: false }, jwt);

    if (cliKeyRes.ok && cliKeyRes.data?.apiKey) {
      const key = cliKeyRes.data.apiKey;
      const cfg = loadConfig() || {};
      cfg.apiKey = key;
      if (!dryRun) saveConfig(cfg);
      ok("Authenticated & API key obtained");
      return key;
    }

    if (cliKeyRes.error?.code === "KEY_EXISTS") {
      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, jwt);
      if (regenRes.ok && regenRes.data?.apiKey) {
        const key = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = key;
        if (!dryRun) saveConfig(cfg);
        ok("API key retrieved");
        return key;
      }
    }
  }

  fail("OAuth login did not produce credentials.");
  return null;
}

// ─── Update Mode ─────────────────────────────────────────────

async function runUpdate(args, deps, equip, platforms, transport, nonInteractive, dryRun) {
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;

  log(`\n${BOLD}Prior Update${RESET}`);
  log("============\n");

  log("Checking credentials...");
  let apiKey = process.env.PRIOR_API_KEY || loadConfig()?.apiKey;

  if (apiKey) {
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (check.ok) {
      const vEmail = check.data.email;
      const vDisplay = vEmail ? vEmail.replace(/^(..)[^@]*/, "$1***") : check.data.agentName || "verified";
      ok(`API key valid (${vDisplay})`);
    } else {
      warn("API key invalid (401)");
      apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
      if (!apiKey) {
        fail("Could not restore authentication.");
        process.exit(1);
      }
      log("\nUpdating MCP configs with new key...");
      for (const p of platforms) {
        try {
          equip.updateMcpKey(p, apiKey, transport);
          ok(`${platformName(p.platform)} (${p.configPath.replace(os.homedir(), "~")})`);
        } catch (e) {
          fail(`${platformName(p.platform)}: ${e.message}`);
        }
      }
    }
  } else {
    apiKey = await resolveAuth(args, deps, nonInteractive, dryRun);
    if (!apiKey) {
      fail("No credentials. Run: prior setup");
      process.exit(1);
    }
  }

  log("\nUpdating behavioral rules...");
  for (const p of platforms) {
    const result = equip.installRules(p, { dryRun });
    if (result.action === "skipped") {
      ok(`${platformName(p.platform)}: No changes needed`);
    } else if (result.action === "updated") {
      ok(`${platformName(p.platform)}: Instructions updated to v${VERSION}`);
    } else if (result.action === "created") {
      ok(`${platformName(p.platform)}: Instructions added`);
    } else if (result.action === "clipboard") {
      info(`${platformName(p.platform)}: Updated instructions copied to clipboard`);
      if (p.platform === "vscode") {
        log(`    → Paste in: .github/copilot-instructions.md`);
      } else {
        log(`    → Paste in: Cursor > Settings > Rules`);
      }
    }

    equip.installSkill(p, { dryRun });
  }

  log("\nUpdating MCP config...");
  for (const p of platforms) {
    if (equip.readMcp(p)) {
      ok(`${platformName(p.platform)}: No changes needed`);
    } else {
      try {
        equip.installMcp(p, apiKey, { transport, dryRun });
        ok(`${platformName(p.platform)}: MCP config restored`);
      } catch (e) {
        fail(`${platformName(p.platform)}: ${e.message}`);
      }
    }
  }

  const platList = platforms.map(p => platformName(p.platform)).join(", ");
  log(`\n${BOLD}Prior updated for ${platList}.${RESET}`);
  log(`\n  Dashboard:  https://prior.cg3.io`);
  log(`  Help:       prior@cg3.io`);
}

// ─── Rekey Mode ──────────────────────────────────────────────

async function runRekey(args, deps, equip, platforms, transport, nonInteractive, dryRun) {
  const { VERSION, API_URL, loadConfig, saveConfig, api } = deps;

  log(`\n${BOLD}Prior Rekey${RESET}`);
  log("===========\n");

  const configured = platforms.filter(p => equip.readMcp(p));
  log("Detecting configured platforms...");
  for (const p of configured) ok(`${platformName(p.platform)} (${transport}, ${p.configPath.replace(os.homedir(), "~")})`);
  for (const p of platforms.filter(pp => !configured.includes(pp))) {
    log(`  ${DIM}— ${platformName(p.platform)}: not configured (skip)${RESET}`);
  }

  if (configured.length === 0) {
    fail("No platforms configured. Run: prior setup");
    process.exit(1);
  }

  let apiKey;
  if (args.apiKey) {
    log("\nValidating provided key...");
    apiKey = args.apiKey;
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (!check.ok) {
      fail("Provided key is invalid.");
      process.exit(1);
    }
    ok("Key valid");
  } else if (args.apiKeyFile) {
    apiKey = deps.readApiKeyFromFile(args.apiKeyFile);
    const check = await api("GET", "/v1/agents/me", null, apiKey);
    if (!check.ok) {
      fail("Key from file is invalid.");
      process.exit(1);
    }
    ok("Key valid");
  } else {
    log("\nGenerating new API key...");
    apiKey = await resolveAuth({ ...args, skipAuth: false }, deps, nonInteractive, dryRun);
    if (!apiKey) {
      fail("Could not obtain new key.");
      process.exit(1);
    }

    const config = loadConfig();
    if (config?.tokens?.access_token) {
      const regenRes = await api("POST", "/v1/agents/cli-key", { regenerate: true }, config.tokens.access_token);
      if (regenRes.ok && regenRes.data?.apiKey) {
        apiKey = regenRes.data.apiKey;
        const cfg = loadConfig() || {};
        cfg.apiKey = apiKey;
        if (!dryRun) saveConfig(cfg);
        ok("New API key generated");
      }
    }
  }

  if (!nonInteractive && !args.apiKey && !args.apiKeyFile) {
    warn("This replaces your previous API key.");
    log("    Any other integrations using the old key will stop working.");
    const confirm = await prompt("  Proceed? [Y/n] ");
    if (confirm.toLowerCase() === "n") {
      log("Cancelled.");
      return;
    }
  }

  log("\nUpdating MCP configs...");
  for (const p of configured) {
    try {
      equip.updateMcpKey(p, apiKey, transport);
      ok(`${platformName(p.platform)} (${p.configPath.replace(os.homedir(), "~")})`);
    } catch (e) {
      fail(`${platformName(p.platform)}: ${e.message}`);
    }
  }

  if (!dryRun) {
    const cfg = loadConfig() || {};
    cfg.apiKey = apiKey;
    saveConfig(cfg);
    ok(`~/.prior/config.json`);
  }

  const platList = configured.map(p => platformName(p.platform)).join(", ");
  log(`\n${BOLD}API key rotated for ${platList}.${RESET}`);
  log(`\n  Dashboard:  https://prior.cg3.io`);
  log(`  Help:       prior@cg3.io`);
}

// ─── Uninstall Mode ──────────────────────────────────────────

async function runUninstall(args, equip, dryRun, VERSION) {
  log(`\n${BOLD}Prior Uninstall${RESET}\n`);

  let platforms = equip.detect();
  if (args.platform) {
    const requested = args.platform.split(",").map(s => resolvePlatformId(s));
    platforms = platforms.filter(p => requested.includes(p.platform));
  }

  if (platforms.length === 0) {
    log("  No Prior installations found.");
    return;
  }

  for (const p of platforms) {
    const mcpRemoved = equip.uninstallMcp(p, dryRun);
    const rulesRemoved = equip.uninstallRules(p, dryRun);
    const skillRemoved = equip.uninstallSkill(p, dryRun);
    const hooksRemoved = equip.uninstallHooks(p, { dryRun });

    if (mcpRemoved || rulesRemoved || skillRemoved || hooksRemoved) {
      ok(`${platformName(p.platform)} ${dryRun ? "would be " : ""}removed`);
      const items = [];
      if (mcpRemoved) items.push("MCP config");
      if (rulesRemoved) items.push("Behavioral rules");
      if (skillRemoved) items.push("Skill files");
      if (hooksRemoved) items.push("Hooks");
      items.forEach((item, i) => {
        const connector = i === items.length - 1 ? "└─" : "├─";
        log(`      ${DIM}${connector}${RESET} ${item}`);
      });
    } else {
      log(`  ${DIM}— ${platformName(p.platform)}   nothing to remove${RESET}`);
    }
  }

  log(`\n  ${DIM}Note: ~/.prior/config.json was NOT removed (contains your auth).${RESET}`);
  log(`  ${DIM}To remove: rm ~/.prior/config.json${RESET}`);
}

// ─── Exports ─────────────────────────────────────────────────

module.exports = {
  cmdSetup,
  createEquip,
  getInstructions,
  sendSetupReport,
  getBundledRules,
  // Prior-specific helpers for tests
  buildMcpConfig: (apiKey, transport, platform) => {
    const equip = createEquip();
    return equip.buildConfig(platform, apiKey, transport);
  },
  parseRulesVersion: (content) => parseRulesVersion(content, PRIOR_MARKER),
  PRIOR_MARKER_RE: markerPatterns(PRIOR_MARKER).MARKER_RE,
  PRIOR_BLOCK_RE: markerPatterns(PRIOR_MARKER).BLOCK_RE,
  // Re-exported from equip for convenience
  createManualPlatform,
  platformName,
  resolvePlatformId,
};
