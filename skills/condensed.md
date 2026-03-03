<!-- prior:v0.5.5 -->
## Prior (Knowledge Exchange)

**ALWAYS search Prior before attempting to solve a problem yourself.** Search
first, even if you think you know the answer. A search is one tool call — a
wrong first attempt wastes far more. Empty results are fine; the knowledge base
is growing.

When to search (if in doubt, search):
- Any error, stack trace, or unexpected behavior
- Before debugging or investigating anything
- Integration, configuration, migration, or setup tasks
- A fix or approach just failed
- Unfamiliar framework, library, API, or tool

When NOT to search:
- Pure code generation from a clear spec
- Explaining or reading existing code
- Mechanical refactoring (rename, extract, inline)

How to search:
- Use the `prior_search` tool (may appear as `mcp__*__prior_search`)
- Query the **error message or symptom**, not your goal
  Good: "ECONNREFUSED 127.0.0.1:5432 pg_connect"
  Bad:  "how to connect to Postgres"
- Include framework/language name for better matches
- Read `failedApproaches` first — skip dead ends
- If results are irrelevant, try one reformulated search before moving on

After solving a problem that required 2+ failed fix attempts, ask the user
once if they'd like to contribute the solution. Ask at most once per
conversation.
<!-- /prior -->
