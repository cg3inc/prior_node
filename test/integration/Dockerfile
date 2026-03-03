FROM node:22-slim

# Create test user with known home directory
RUN useradd -m -s /bin/bash testuser

# ─── Mock Claude Code ────────────────────────────────────────
# Simulates: claude CLI available, existing .claude dir, existing CLAUDE.md with user content, 
# existing .claude.json with another MCP server
RUN mkdir -p /home/testuser/.claude/skills && \
    echo '{"mcpServers":{"existing-server":{"url":"https://example.com","headers":{"X-Custom":"value"}}}}' > /home/testuser/.claude.json && \
    printf '# My Project Rules\n\nAlways write tests.\nUse TypeScript.\n' > /home/testuser/.claude/CLAUDE.md && \
    printf '#!/bin/sh\necho "Claude Code v2.1.0"' > /usr/local/bin/claude && chmod +x /usr/local/bin/claude

# ─── Mock Cursor ─────────────────────────────────────────────
# Simulates: cursor dir exists, existing mcp.json with another server
RUN mkdir -p /home/testuser/.cursor && \
    echo '{"mcpServers":{"another-mcp":{"command":"npx","args":["-y","some-tool"],"env":{"TOKEN":"abc"}}}}' > /home/testuser/.cursor/mcp.json && \
    printf '#!/bin/sh\necho "0.48.2"' > /usr/local/bin/cursor && chmod +x /usr/local/bin/cursor

# ─── Mock Windsurf ───────────────────────────────────────────
# Simulates: windsurf dir exists, existing global rules with user content
RUN mkdir -p /home/testuser/.codeium/windsurf/memories && \
    echo '{"mcpServers":{}}' > /home/testuser/.codeium/windsurf/mcp_config.json && \
    printf '# My Windsurf Rules\n\nPrefer functional style.\n' > /home/testuser/.codeium/windsurf/memories/global_rules.md

# Fix ownership
RUN chown -R testuser:testuser /home/testuser

# Copy prior-node source
WORKDIR /app
COPY . .
RUN chown -R testuser:testuser /app

USER testuser
ENV HOME=/home/testuser

# Verify setup
RUN node --version && ls bin/setup.js skills/condensed.md
