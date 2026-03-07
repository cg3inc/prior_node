#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

// ── Config ──
const STALE_HOURS = 4;
const MAX_SEQUENCE = 20;
const MAX_HISTORY = 5;

// ── State Management ──
function stateDir() { return os.tmpdir(); }
function stateFile() { return path.join(stateDir(), "prior-hooks.json"); }

function freshPrompt(now) {
  return {
    startedAt: now, lastToolAt: now,
    lastErrorAt: null, lastSearchAt: null,
    toolCalls: 0, errorCount: 0, searchCount: 0,
    editCount: 0, contributionCount: 0,
    toolSequence: [], nudgesFired: []
  };
}

function freshState(now) {
  return {
    v: 1,
    session: {
      startedAt: now, lastToolAt: now,
      promptCount: 0, totalToolCalls: 0,
      totalErrors: 0, totalSearches: 0,
      totalContributions: 0, toolFrequency: {}
    },
    prompt: freshPrompt(now),
    promptHistory: []
  };
}

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), "utf-8"));
    // Reset if stale (old session)
    if (s.session && (Date.now() - s.session.lastToolAt) > STALE_HOURS * 3600000) {
      return freshState(Date.now());
    }
    return s;
  } catch { return freshState(Date.now()); }
}

function writeState(s) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {}
}

// ── Event Detection ──
function detectEvent(input) {
  if (input.error !== undefined) return "PostToolUseFailure";
  if (input.last_assistant_message !== undefined) return "Stop";
  if (input.tool_name !== undefined) return "PostToolUse";
  return null;
}

// ── Collectors ──
function collectTool(state, input, isFailure) {
  const now = Date.now();
  const tool = input.tool_name || "unknown";

  state.prompt.toolCalls++;
  state.session.totalToolCalls++;
  state.prompt.lastToolAt = now;
  state.session.lastToolAt = now;
  state.session.toolFrequency[tool] = (state.session.toolFrequency[tool] || 0) + 1;

  // Tool sequence (capped)
  state.prompt.toolSequence.push({ tool, at: now, ok: !isFailure });
  if (state.prompt.toolSequence.length > MAX_SEQUENCE)
    state.prompt.toolSequence.shift();

  // Error tracking
  if (isFailure) {
    state.prompt.errorCount++;
    state.session.totalErrors++;
    state.prompt.lastErrorAt = now;
    // Re-arm search nudge on new error
    const idx = state.prompt.nudgesFired.indexOf("search");
    if (idx !== -1) state.prompt.nudgesFired.splice(idx, 1);
  }

  // Prior search tracking
  if (tool.includes("prior_search")) {
    state.prompt.searchCount++;
    state.session.totalSearches++;
    state.prompt.lastSearchAt = now;
  }

  // Prior contribute tracking
  if (tool.includes("prior_contribute")) {
    state.prompt.contributionCount++;
    state.session.totalContributions++;
  }

  // Edit tracking
  if (tool === "Edit" || tool === "Write" || tool === "MultiEdit") {
    state.prompt.editCount++;
  }
}

function collectStop(state) {
  // Snapshot prompt into history
  const p = state.prompt;
  state.promptHistory.push({
    i: state.session.promptCount,
    tools: p.toolCalls, errors: p.errorCount,
    searches: p.searchCount, edits: p.editCount,
    nudges: [...p.nudgesFired]
  });
  if (state.promptHistory.length > MAX_HISTORY)
    state.promptHistory.shift();

  state.session.promptCount++;
  state.prompt = freshPrompt(Date.now());
}

// ── Evaluators ──
function evalSearchNudge(state, input) {
  if (state.prompt.nudgesFired.includes("search")) return null;

  // Must have an unresearched error
  if (!state.prompt.lastErrorAt) return null;
  if (state.prompt.lastSearchAt && state.prompt.lastSearchAt >= state.prompt.lastErrorAt) return null;

  // Don't nudge on the search call itself
  const tool = input.tool_name || "";
  if (tool.includes("prior_search")) return null;

  state.prompt.nudgesFired.push("search");
  return "\u26a0\ufe0f You hit an error and moved on without searching Prior. " +
    "Use prior_search with the error text \u2014 your user has invested credits for this.";
}

function evalContributeNudge(state, input) {
  if (state.prompt.nudgesFired.includes("contribute")) return null;

  // Need real iterative work: multiple errors, multiple edits, at least one search
  if (state.prompt.errorCount < 2) return null;
  if (state.prompt.editCount < 1) return null;
  if (state.prompt.searchCount < 1) return null;
  if (state.prompt.contributionCount > 0) return null;

  // Time gate: prompt must be at least 30 seconds old
  if (Date.now() - state.prompt.startedAt < 30000) return null;

  state.prompt.nudgesFired.push("contribute");
  return "You've iterated through multiple errors and fixes this prompt. " +
    "Consider contributing your solution to Prior \u2014 other agents will hit the same issue.";
}

// ── Main ──
const chunks = [];
process.stdin.on("data", c => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const event = detectEvent(input);
    if (!event) { process.exit(0); return; }

    const state = readState();

    if (event === "Stop") {
      collectStop(state);
      writeState(state);
      process.exit(0);
      return;
    }

    const isFailure = event === "PostToolUseFailure";
    collectTool(state, input, isFailure);

    // Run evaluators (first match wins)
    let context = null;
    if (isFailure) {
      // On failure events, record but nudge comes on the NEXT non-search tool call
      // (the search nudge fires on PostToolUse, not PostToolUseFailure)
    } else {
      context = evalSearchNudge(state, input) || evalContributeNudge(state, input);
    }

    writeState(state);

    if (context) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: context
        }
      }));
    }
  } catch { process.exit(0); }
});
