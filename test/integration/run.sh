#!/bin/bash
# Prior Setup Integration Tests
# Runs in Docker: tests install/uninstall/update lifecycle against mock platform environments.
#
# Usage:
#   ./run.sh                    # Build + run all tests
#   ./run.sh --skip-build       # Reuse existing image
#   ./run.sh --test 03          # Run specific test
#   ./run.sh --api-key ask_...  # Use real API key for verification tests
#   ./run.sh --json             # JSON output for dashboard
#
# Designed to run on Raspberry Pi (arm64) or any Docker host.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PRIOR_NODE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
IMAGE_NAME="prior-setup-test"
SKIP_BUILD=false
SPECIFIC_TEST=""
API_KEY="${PRIOR_API_KEY:-}"
JSON_OUTPUT=false
RESULTS_DIR="${RESULTS_DIR:-$SCRIPT_DIR/results/$(date +%Y%m%dT%H%M%S)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --test) SPECIFIC_TEST="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --json) JSON_OUTPUT=true; shift ;;
    --results-dir) RESULTS_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

mkdir -p "$RESULTS_DIR"

# ─── Output helpers ──────────────────────────────────────────

PASS=0; FAIL=0; SKIP=0; TESTS=()

pass() { PASS=$((PASS+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"pass\"}"); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"fail\",\"error\":\"$2\"}"); echo "  ✗ $1: $2"; }
skip() { SKIP=$((SKIP+1)); TESTS+=("{\"name\":\"$1\",\"status\":\"skip\",\"reason\":\"$2\"}"); echo "  — $1: $2"; }
section() { echo ""; echo "── $1 ──"; }

# Run a command inside the Docker container
drun() {
  docker run --rm "$IMAGE_NAME" bash -c "$1"
}

# Run and capture output
dcapture() {
  docker run --rm "$IMAGE_NAME" bash -c "$1" 2>&1
}

# Run with a named volume for state persistence across steps
VOLUME_NAME="prior-setup-test-$$"
drun_stateful() {
  docker run --rm -v "$VOLUME_NAME:/home/testuser" "$IMAGE_NAME" bash -c "$1"
}

# ─── Build ───────────────────────────────────────────────────

if [ "$SKIP_BUILD" = false ]; then
  section "Building Docker image"
  echo "  Context: $PRIOR_NODE_DIR"
  docker build -t "$IMAGE_NAME" -f "$SCRIPT_DIR/Dockerfile" "$PRIOR_NODE_DIR" > "$RESULTS_DIR/build.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "  ✗ Docker build failed"
    cat "$RESULTS_DIR/build.log"
    exit 1
  fi
  echo "  ✓ Image built: $IMAGE_NAME"
fi

# ─── Test 01: Detection ─────────────────────────────────────

should_run() {
  [ -z "$SPECIFIC_TEST" ] || [ "$SPECIFIC_TEST" = "$1" ]
}

if should_run "01"; then
  section "01: Platform Detection"

  OUT=$(dcapture 'node -e "
    const { detectPlatforms } = require(\"./bin/setup.js\");
    const ps = detectPlatforms();
    console.log(JSON.stringify(ps.map(p => ({ platform: p.platform, version: p.version, hasCli: p.hasCli }))));
  "')

  # Should detect all 3 platforms
  echo "$OUT" | grep -q '"claude-code"' && pass "Detects Claude Code" || fail "Detects Claude Code" "not found"
  echo "$OUT" | grep -q '"cursor"' && pass "Detects Cursor" || fail "Detects Cursor" "not found"
  echo "$OUT" | grep -q '"windsurf"' && pass "Detects Windsurf" || fail "Detects Windsurf" "not found"

  # Should detect CLI availability
  echo "$OUT" | grep -q '"hasCli":true' && pass "Detects claude CLI" || fail "Detects claude CLI" "hasCli not true"

  # Should detect versions
  echo "$OUT" | grep -q '2.1.0' && pass "Claude Code version detected" || fail "Claude Code version" "version not found"
  echo "$OUT" | grep -q '0.48.2' && pass "Cursor version detected" || fail "Cursor version" "version not found"
fi

# ─── Test 02: Install (per-platform, non-interactive) ────────

if should_run "02"; then
  section "02: MCP Installation"

  # Claude Code — JSON fallback (claude mcp add won't work in container)
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test123\"), false);
    const fs = require(\"fs\");
    const data = JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"));
    console.log(JSON.stringify(data));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior.url' > /dev/null 2>&1 && pass "Claude Code: prior MCP added" || fail "Claude Code: prior MCP added" "missing"
  echo "$OUT" | jq -e '.mcpServers["existing-server"].url' > /dev/null 2>&1 && pass "Claude Code: existing server preserved" || fail "Claude Code: existing server preserved" "clobbered"
  echo "$OUT" | jq -r '.mcpServers.prior.headers.Authorization' 2>/dev/null | grep -q "ask_test123" && pass "Claude Code: auth header set" || fail "Claude Code: auth header" "wrong"

  # Cursor
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"cursor\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test456\"), false);
    const fs = require(\"fs\");
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"))));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior' > /dev/null 2>&1 && pass "Cursor: prior MCP added" || fail "Cursor: prior MCP added" "missing"
  echo "$OUT" | jq -e '.mcpServers["another-mcp"]' > /dev/null 2>&1 && pass "Cursor: existing server preserved" || fail "Cursor: existing server preserved" "clobbered"

  # Windsurf
  OUT=$(dcapture 'node -e "
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"windsurf\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_test789\"), false);
    const fs = require(\"fs\");
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(p.configPath, \"utf-8\"))));
  "')

  echo "$OUT" | jq -e '.mcpServers.prior' > /dev/null 2>&1 && pass "Windsurf: prior MCP added" || fail "Windsurf: prior MCP added" "missing"
fi

# ─── Test 03: Rules Installation ─────────────────────────────

if should_run "03"; then
  section "03: Behavioral Rules Installation"

  # Claude Code — append to existing CLAUDE.md
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    const result = installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    console.log(JSON.stringify({ action: result.action, hasOriginal: content.includes(\"Always write tests\"), hasPrior: content.includes(\"ALWAYS search Prior\"), hasMarker: content.includes(\"prior:v\") }));
  "')

  echo "$OUT" | jq -e '.action == "created"' > /dev/null 2>&1 && pass "Claude Code: rules created" || fail "Claude Code: rules created" "$(echo $OUT | jq -r '.action')"
  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Claude Code: existing content preserved" || fail "Claude Code: existing content preserved" "lost"
  echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "Claude Code: Prior rules present" || fail "Claude Code: Prior rules present" "missing"
  echo "$OUT" | jq -e '.hasMarker == true' > /dev/null 2>&1 && pass "Claude Code: version marker present" || fail "Claude Code: version marker" "missing"

  # Windsurf — append to existing global_rules.md
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"windsurf\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    console.log(JSON.stringify({ hasOriginal: content.includes(\"Prefer functional\"), hasPrior: content.includes(\"ALWAYS search Prior\") }));
  "')

  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Windsurf: existing rules preserved" || fail "Windsurf: existing rules preserved" "lost"
  echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "Windsurf: Prior rules appended" || fail "Windsurf: Prior rules appended" "missing"

  # Idempotency — running install twice doesn't duplicate
  OUT=$(dcapture 'node -e "
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const fs = require(\"fs\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);
    installRules(p, rules, version, false);
    const r2 = installRules(p, rules, version, false);
    const content = fs.readFileSync(p.rulesPath, \"utf-8\");
    const count = (content.match(/<!-- prior:v/g) || []).length;
    console.log(JSON.stringify({ secondAction: r2.action, markerCount: count }));
  "')

  echo "$OUT" | jq -e '.secondAction == "skipped"' > /dev/null 2>&1 && pass "Rules: idempotent (second run skipped)" || fail "Rules: idempotent" "$(echo $OUT | jq -r '.secondAction')"
  echo "$OUT" | jq -e '.markerCount == 1' > /dev/null 2>&1 && pass "Rules: no duplicate markers" || fail "Rules: duplicate markers" "count=$(echo $OUT | jq '.markerCount')"
fi

# ─── Test 04: Full Roundtrip (Install → Verify → Uninstall → Verify) ────

if should_run "04"; then
  section "04: Full Install/Uninstall Roundtrip"

  for PLATFORM in claude-code cursor windsurf; do
    OUT=$(dcapture "node -e \"
      const fs = require('fs');
      const { installMcpJson, uninstallMcp, installRules, uninstallRules, getBundledRules, parseRulesVersion, buildHttpConfigWithAuth, createManualPlatform } = require('./bin/setup.js');
      const p = createManualPlatform('$PLATFORM');

      // Snapshot initial state
      let initialMcp = null;
      try { initialMcp = fs.readFileSync(p.configPath, 'utf-8'); } catch {}
      let initialRules = null;
      try { initialRules = fs.readFileSync(p.rulesPath, 'utf-8'); } catch {}

      // Install
      installMcpJson(p, buildHttpConfigWithAuth('ask_roundtrip'), false);
      const rules = getBundledRules();
      const version = parseRulesVersion(rules);
      if (p.rulesPath) installRules(p, rules, version, false);

      // Verify installed
      const mcpAfterInstall = JSON.parse(fs.readFileSync(p.configPath, 'utf-8'));
      const hasPrior = !!mcpAfterInstall.mcpServers?.prior;

      // Uninstall
      uninstallMcp(p, false);
      if (p.rulesPath) uninstallRules(p, false);

      // Verify uninstalled — MCP
      let finalMcp = null;
      try { finalMcp = fs.readFileSync(p.configPath, 'utf-8'); } catch {}
      const finalMcpObj = finalMcp ? JSON.parse(finalMcp) : null;
      const priorGone = !finalMcpObj?.mcpServers?.prior;

      // Check other servers survived
      const initialObj = initialMcp ? JSON.parse(initialMcp) : {};
      const otherServers = Object.keys(initialObj.mcpServers || {});
      const othersPreserved = otherServers.every(k => finalMcpObj?.mcpServers?.[k]);

      // Verify uninstalled — Rules
      let finalRules = null;
      try { finalRules = fs.readFileSync(p.rulesPath, 'utf-8'); } catch {}
      const rulesClean = !finalRules || !finalRules.includes('prior:v');
      const originalContentPreserved = !initialRules || !finalRules || initialRules.trim().split('\\n').slice(0, 2).every(l => finalRules.includes(l.trim()));

      console.log(JSON.stringify({
        platform: '$PLATFORM',
        hasPrior, priorGone, othersPreserved, rulesClean, originalContentPreserved
      }));
    \"")

    echo "$OUT" | jq -e '.hasPrior == true' > /dev/null 2>&1 && pass "$PLATFORM: prior installed" || fail "$PLATFORM: prior installed" "missing after install"
    echo "$OUT" | jq -e '.priorGone == true' > /dev/null 2>&1 && pass "$PLATFORM: prior removed after uninstall" || fail "$PLATFORM: prior removed" "still present"
    echo "$OUT" | jq -e '.othersPreserved == true' > /dev/null 2>&1 && pass "$PLATFORM: other servers preserved" || fail "$PLATFORM: other servers" "lost"
    echo "$OUT" | jq -e '.rulesClean == true' > /dev/null 2>&1 && pass "$PLATFORM: rules cleaned" || fail "$PLATFORM: rules" "still has prior content"
    echo "$OUT" | jq -e '.originalContentPreserved == true' > /dev/null 2>&1 && pass "$PLATFORM: original content intact" || fail "$PLATFORM: original content" "lost"
  done
fi

# ─── Test 05: Rules Update (version bump) ────────────────────

if should_run "05"; then
  section "05: Rules Version Update"

  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const { installRules, getBundledRules, parseRulesVersion, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    const rules = getBundledRules();
    const version = parseRulesVersion(rules);

    // Install current version
    installRules(p, rules, version, false);

    // Simulate old version already installed
    let content = fs.readFileSync(p.rulesPath, \"utf-8\");
    content = content.replace(\"prior:v\" + version, \"prior:v0.1.0\");
    fs.writeFileSync(p.rulesPath, content);

    // Update should replace
    const r = installRules(p, rules, version, false);
    const final = fs.readFileSync(p.rulesPath, \"utf-8\");
    const hasNew = final.includes(\"prior:v\" + version);
    const hasOld = final.includes(\"prior:v0.1.0\");
    const count = (final.match(/<!-- prior:v/g) || []).length;
    const hasOriginal = final.includes(\"Always write tests\");

    console.log(JSON.stringify({ action: r.action, hasNew, hasOld, count, hasOriginal }));
  "')

  echo "$OUT" | jq -e '.action == "updated"' > /dev/null 2>&1 && pass "Update: action is 'updated'" || fail "Update: action" "$(echo $OUT | jq -r '.action')"
  echo "$OUT" | jq -e '.hasNew == true' > /dev/null 2>&1 && pass "Update: new version present" || fail "Update: new version" "missing"
  echo "$OUT" | jq -e '.hasOld == false' > /dev/null 2>&1 && pass "Update: old version removed" || fail "Update: old version" "still present"
  echo "$OUT" | jq -e '.count == 1' > /dev/null 2>&1 && pass "Update: exactly one marker" || fail "Update: marker count" "$(echo $OUT | jq '.count')"
  echo "$OUT" | jq -e '.hasOriginal == true' > /dev/null 2>&1 && pass "Update: original content preserved" || fail "Update: original content" "lost"
fi

# ─── Test 06: Stdio Transport Config ─────────────────────────

if should_run "06"; then
  section "06: Stdio Transport Config"

  OUT=$(dcapture 'node -e "
    const { buildStdioConfig } = require(\"./bin/setup.js\");
    const config = buildStdioConfig(\"ask_stdio_test\");
    console.log(JSON.stringify(config));
  "')

  echo "$OUT" | jq -e '.command == "npx"' > /dev/null 2>&1 && pass "Stdio: command is npx (Linux)" || fail "Stdio: command" "$(echo $OUT | jq -r '.command')"
  echo "$OUT" | jq -e '.args | length == 3' > /dev/null 2>&1 && pass "Stdio: correct args" || fail "Stdio: args" "$(echo $OUT | jq '.args')"
  echo "$OUT" | jq -e '.env.PRIOR_API_KEY == "ask_stdio_test"' > /dev/null 2>&1 && pass "Stdio: API key in env" || fail "Stdio: env" "missing"
fi

# ─── Test 07: Backup Creation ────────────────────────────────

if should_run "07"; then
  section "07: Config Backup"

  OUT=$(dcapture 'node -e "
    const fs = require(\"fs\");
    const { installMcpJson, buildHttpConfigWithAuth, createManualPlatform } = require(\"./bin/setup.js\");
    const p = createManualPlatform(\"claude-code\");
    installMcpJson(p, buildHttpConfigWithAuth(\"ask_backup\"), false);
    const bakExists = fs.existsSync(p.configPath + \".bak\");
    const bakContent = bakExists ? JSON.parse(fs.readFileSync(p.configPath + \".bak\", \"utf-8\")) : null;
    const hasOriginalInBak = bakContent?.mcpServers?.[\"existing-server\"] != null;
    console.log(JSON.stringify({ bakExists, hasOriginalInBak }));
  "')

  echo "$OUT" | jq -e '.bakExists == true' > /dev/null 2>&1 && pass "Backup: .bak file created" || fail "Backup: .bak missing" "not created"
  echo "$OUT" | jq -e '.hasOriginalInBak == true' > /dev/null 2>&1 && pass "Backup: contains original config" || fail "Backup: wrong content" "missing original"
fi

# ─── Test 08: Dry Run (real API if key provided) ─────────────

if should_run "08"; then
  section "08: Dry Run / Full CLI"

  if [ -n "$API_KEY" ]; then
    OUT=$(dcapture "node bin/prior.js setup --dry-run --non-interactive --platform claude-code --api-key $API_KEY 2>&1 || true")

    echo "$OUT" | grep -q "Authenticated" && pass "CLI dry-run: authenticated" || fail "CLI dry-run: auth" "no auth"
    echo "$OUT" | grep -q "would be" && pass "CLI dry-run: shows dry-run output" || fail "CLI dry-run: output" "missing dry-run text"
    echo "$OUT" | grep -q "MCP server" && pass "CLI dry-run: MCP step shown" || fail "CLI dry-run: MCP" "missing"

    # Verify no files were written
    OUT2=$(dcapture 'node -e "
      const fs = require(\"fs\");
      const data = JSON.parse(fs.readFileSync(\"/home/testuser/.claude.json\", \"utf-8\"));
      console.log(JSON.stringify({ hasPrior: !!data.mcpServers?.prior }));
    "')
    echo "$OUT2" | jq -e '.hasPrior == false' > /dev/null 2>&1 && pass "CLI dry-run: no files modified" || fail "CLI dry-run: files modified" "prior entry found"
  else
    skip "CLI dry-run with real API" "No API key provided (--api-key)"
  fi
fi

# ─── Cleanup ─────────────────────────────────────────────────

docker volume rm "$VOLUME_NAME" 2>/dev/null || true

# ─── Summary ─────────────────────────────────────────────────

TOTAL=$((PASS + FAIL + SKIP))
echo ""
echo "═══════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed, $SKIP skipped ($TOTAL total)"
echo "═══════════════════════════════════"

# Write JSON results
TESTS_JSON=$(printf '%s\n' "${TESTS[@]}" | paste -sd, -)
cat > "$RESULTS_DIR/results.json" <<EOF
{
  "timestamp": "$(date -Iseconds)",
  "image": "$IMAGE_NAME",
  "pass": $PASS,
  "fail": $FAIL,
  "skip": $SKIP,
  "total": $TOTAL,
  "tests": [$TESTS_JSON]
}
EOF

echo "  Results: $RESULTS_DIR/results.json"

if [ "$JSON_OUTPUT" = true ]; then
  cat "$RESULTS_DIR/results.json"
fi

[ $FAIL -eq 0 ] && exit 0 || exit 1
