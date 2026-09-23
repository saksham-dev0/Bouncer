# Bouncer — Phase 0 spike findings (2026-09-23)

Claude Code 2.1.280, Node v24.18.0.

## Hook payloads (checked with a throwaway probe plugin, `claude -p --plugin-dir`)

| Check | Result |
|---|---|
| (a) UserPromptSubmit gets raw slash command + session id | **Yes.** `{"session_id": "...", "prompt": "/probe:on", "cwd": "...", "prompt_id": "...", "hook_event_name": "UserPromptSubmit"}` |
| (b) `${CLAUDE_PLUGIN_ROOT}` expands inside command `!` bash | **Yes.** It printed the plugin's absolute path |
| (c) Read `tool_input` shape | `{"file_path": "<absolute path>"}`, plus `limit`/`offset` when used |
| (d) Subagent reads are distinguishable | **Yes.** They carry `"agent_id": "ab207cb46374278b9", "agent_type": "general-purpose"`; main-session reads have neither |

The per-session toggle via UserPromptSubmit works as designed, so no fallback is needed.
The gate can use `agent_id` to exempt subagents.

## Latency

**Not measured.** `TYPESAFE_API_KEY` was not set in the build session. The go/no-go
check (median skim300 + close20 < 3s) is deferred to the first live run of
`scripts/map-cli.mjs` (Task 5) once the key is set.
