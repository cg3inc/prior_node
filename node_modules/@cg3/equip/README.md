# @cg3/equip

Universal MCP server + behavioral rules installer for AI coding agents.

Equip handles the hard part of distributing your MCP tool: detecting which AI coding platforms are installed, writing the correct config format for each one, and managing versioned behavioral rules — all with zero dependencies.

## Supported Platforms

| Platform | MCP Config | Rules |
|---|---|---|
| Claude Code | `~/.claude.json` (`mcpServers`) | `~/.claude/CLAUDE.md` (append) |
| Cursor | `~/.cursor/mcp.json` (`mcpServers`) | Clipboard (no writable global path) |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) | `global_rules.md` (append) |
| VS Code | `Code/User/mcp.json` (`servers`, `type: "http"`) | Clipboard |
| Cline | `globalStorage/.../cline_mcp_settings.json` (`mcpServers`) | `~/Documents/Cline/Rules/` (standalone file) |
| Roo Code | `globalStorage/.../cline_mcp_settings.json` (`mcpServers`) | `~/.roo/rules/` (standalone file) |

## Usage

```js
const { Equip } = require("@cg3/equip");

const equip = new Equip({
  name: "my-tool",
  serverUrl: "https://mcp.example.com",
  rules: {
    content: `<!-- my-tool:v1.0.0 -->\n## My Tool\nAlways check My Tool first.\n<!-- /my-tool -->`,
    version: "1.0.0",
    marker: "my-tool",
    fileName: "my-tool.md",  // For platforms with rules directories
  },
});

// Detect installed platforms
const platforms = equip.detect();

// Install MCP + rules on all detected platforms
for (const p of platforms) {
  equip.installMcp(p, "api_key_here");
  equip.installRules(p);
}

// Uninstall
for (const p of platforms) {
  equip.uninstallMcp(p);
  equip.uninstallRules(p);
}
```

## API

### `new Equip(config)`

- `config.name` — Server name in MCP configs (required)
- `config.serverUrl` — Remote MCP server URL (required unless `stdio` provided)
- `config.rules` — Behavioral rules config (optional)
  - `content` — Markdown content with version markers
  - `version` — Version string for idempotency tracking
  - `marker` — Marker name used in `<!-- marker:vX.X -->` comments
  - `fileName` — Standalone filename for directory-based platforms
  - `clipboardPlatforms` — Platform IDs that use clipboard (default: `["cursor", "vscode"]`)
- `config.stdio` — Stdio transport config (optional, alternative to HTTP)
  - `command`, `args`, `envKey`

### Instance Methods

- `equip.detect()` — Returns array of detected platform objects
- `equip.installMcp(platform, apiKey, options?)` — Install MCP config
- `equip.uninstallMcp(platform, dryRun?)` — Remove MCP config
- `equip.updateMcpKey(platform, apiKey, transport?)` — Update API key
- `equip.installRules(platform, options?)` — Install behavioral rules
- `equip.uninstallRules(platform, dryRun?)` — Remove behavioral rules
- `equip.readMcp(platform)` — Check if MCP is configured
- `equip.buildConfig(platformId, apiKey, transport?)` — Build MCP config object

### Primitives

All internal functions are also exported for advanced usage:

```js
const { detectPlatforms, installMcpJson, installRules, createManualPlatform, platformName, cli } = require("@cg3/equip");
```

## Key Features

- **Zero dependencies** — Pure Node.js, works with Node 18+
- **Platform-aware** — Handles each platform's config quirks (root keys, URL fields, type requirements)
- **Non-destructive** — Merges into existing configs, creates backups, preserves other servers
- **Versioned rules** — Marker-based blocks enable idempotent updates without clobbering user content
- **Dry-run support** — Preview changes without writing files
- **CLI helpers** — Colored output, prompts, clipboard utilities included

## License

MIT — CG3 LLC
