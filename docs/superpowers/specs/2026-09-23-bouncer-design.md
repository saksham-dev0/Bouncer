# Bouncer — Design & Build Plan (v2)

**Date:** 2026-09-23
**Status:** Draft, awaiting review. Nothing is built yet.

---

## 0. The one-paragraph version

You install the plugin and type **`/bouncer:on`** once in a session. From then
on, every time you send a prompt, Bouncer uses TypeSafe's Jev model to scan
your repo's file list. It picks the handful of files the task actually needs
and hands Claude that shortlist before Claude starts working. Claude goes
straight to the right files instead of grepping and reading its way around the
repo. If Claude still tries to read a file Bouncer judged irrelevant, the read
is skipped with a short note. Result: fewer file reads, fewer tokens, same
answer. **`/bouncer:off`** turns it off.

---

## 1. What the user does

### Install (once)

```bash
export TYPESAFE_API_KEY="ts_..."          # from console.typesafe.ai/keys, put in ~/.zshrc
```
```
/plugin marketplace add saksham-dev0/claude-plugin
/plugin install bouncer@my-marketplace
```

### Use: two ways, same engine

| Command | When to use | What happens |
|---|---|---|
| `/bouncer:on` | Once per session (main way) | Every prompt after this gets a file shortlist automatically, until `/bouncer:off` |
| `/bouncer:off` | When you want normal behaviour back | Bouncer stops mapping and stops gating |
| `/bouncer:map <task>` | One-off, without turning it on | Runs your task once with a shortlist, just for that prompt |
| `/bouncer:stats` | Anytime | Shows reads saved, estimated tokens saved, cost |

### What you see

```
> /bouncer:on
Bouncer ON for this session. Each prompt gets a TypeSafe file map.

> add rate limiting to the /login endpoint

  ⎿ Bouncer: 412 files scanned → 5 picked (1.1s)
      core        src/auth/login.ts
                  src/middleware/index.ts
      supporting  src/auth/session.ts
                  src/config/limits.ts
                  test/auth/login.test.ts

Claude: I'll start with src/auth/login.ts and src/middleware/index.ts...
  Read src/auth/login.ts                ✓
  Read src/middleware/index.ts          ✓
  Read src/billing/invoice.ts           ✗ Bouncer: not relevant to this task (read again if needed)
  Edit src/middleware/index.ts          ✓
```

Short follow-ups like "yes", "go ahead" or "also /signup" reuse or extend the
current map. They don't trigger a fresh scan unless the task changed.

---

## 2. Why this saves tokens

Without Bouncer, Claude orients itself by exploring: `Glob`, `Grep`, and reading
5–20 files to find the 3 that matter. Each full-file read costs roughly 1–10k
tokens.

With Bouncer:
1. **The shortlist replaces exploration.** Claude is told up front which files
   matter, so it skips most searching and the speculative reads. This is the
   main saving.
2. **The read gate catches the rest.** Reads of files Bouncer scored as
   irrelevant are skipped. That costs a one-line note instead of the whole file.
3. **Jev is cheap and fast.** Scanning 1,000 files is about 60k input tokens on
   Jev, roughly $0.0025 at $0.042 per million tokens. Those tokens are billed by
   TypeSafe, not added to Claude's context.

The shortlist is advice, not a cage. Claude can still read any file; a read the
gate skipped goes through if Claude asks for it again.

---

## 3. How it works inside

```
 /bouncer:on ─► session flag = on
                                                     ┌──────────────── TypeSafe Jev ───────────────┐
 user prompt ─► [UserPromptSubmit hook] map.mjs      │                                             │
                  1. new task or follow-up? ─────────┼─► Noul: "is `prompt` a new task?"           │
                  2. list repo files (git ls-files)  │                                             │
                  3. skim: every file, path+symbols ─┼─► 1 Noul per file, batched, in parallel     │
                  4. top ~20 → close look w/ head ───┼─► 1 Score per file (core…unrelated)         │
                  5. build map, save it              └─────────────────────────────────────────────┘
                  6. inject map into Claude's context (additionalContext)
                                   │
 Claude Read ─► [PreToolUse hook] gate.mjs   (no Jev call; uses saved map)
                  in map / not scanned / retry / tiny / outside repo → allow
                  scored irrelevant in skim                           → skip w/ note
```

This follows two TypeSafe patterns:
- **Skim-then-read-closely.** Their "Skill suggestion" cookbook ranks 182 skills
  cheaply, then re-checks the top 3 with full detail.
- **Suggestion line.** The same cookbook injects the winner into the agent's
  context as a hint, and the agent keeps its own judgement.

### 3.1 Step 1: new task or follow-up?

This step only runs when a previous map exists. One request:

```json
{
  "state": { "previous_task": "add rate limiting to the /login endpoint",
             "prompt": "also cover /signup" },
  "questions": {
    "new_task": { "type": "noul",
      "instructions": "Does `prompt` start a different task from `previous_task`, rather than continuing, approving or refining it?" },
    "adds_scope": { "type": "noul",
      "instructions": "Does `prompt` mention files, features or areas of the code that `previous_task` does not already cover?" },
    "needs_code": { "type": "noul",
      "instructions": "Does doing what `prompt` asks, in the context of `previous_task`, require reading source files in the repository?" }
  }
}
```

Code decides what to do with the answers:
- `needs_code` < 0.3 (for example "commit this" or "what's a mutex?"): no scan, no gating for this turn.
- `new_task` < 0.5 and `adds_scope` < 0.5 (for example "yes go ahead"): reuse the current map, with no scan.
- `new_task` < 0.5 and `adds_scope` ≥ 0.5 (for example "also cover /signup"):
  re-scan, with the task text set to the old task plus the new prompt. The
  symbol cache keeps this fast.
- Otherwise: full scan with the new prompt as the task.

On the first prompt, there's no previous task. `needs_code` is then asked
inside the skim request itself, as one extra question in batch 0, so it costs
no extra round trip.

### 3.2 Step 2: candidate files (code only)

- Run `git ls-files` (falling back to a directory walk that respects `.gitignore`).
- Drop lockfiles, binaries, images, `dist/`, `build/`, `vendor/`, `node_modules/`
  and minified files.
- For each file, extract up to 15 symbol names locally with regex
  (`function|class|def|fn|func|export|interface|type|struct`).
- Cache the results in `~/.claude/bouncer/cache/<repo-hash>.json`, keyed by path
  and mtime, so re-scans only re-extract changed files.
- Large repos (more than 1,500 files) first get a **directory pass**: one Noul
  per top-level folder, and only folders scoring 0.3 or higher are expanded.
  This follows the hierarchical classification cookbook.

### 3.3 Step 3: skim, every candidate

State is small (the task only). Each question carries its own file, so there is
no context rot from a huge state:

```json
{
  "state": { "task": "add rate limiting to the /login endpoint" },
  "questions": {
    "f_0012": { "type": "noul",
      "instructions": {
        "file": { "path": "src/auth/login.ts", "symbols": ["loginHandler", "verifyPassword"] },
        "question": "Would a developer doing `task` likely need to open `file`?" } },
    "f_0013": { "...": "one per file" }
  }
}
```

- Batches of about 300 questions per request stay under Jev's 64k request budget.
  Batches are sent in parallel.
- Output: `skim[path] = noul`.

### 3.4 Step 4: close look, top ~20

This step takes the top 20 files by skim score, plus any file named in the
prompt. One request:

```json
{
  "state": { "task": "add rate limiting to the /login endpoint" },
  "questions": {
    "r_0012": { "type": "score",
      "instructions": {
        "file": { "path": "src/auth/login.ts", "head": "<first 40 lines>" },
        "question": "How relevant is `file` to doing `task`?" },
      "criteria": [
        "Unrelated: a different feature or area than the task",
        "Tangential: same general area, but not needed for the task",
        "Supporting: useful context (callers, types, config, tests of the target)",
        "Core: the task directly changes or depends on this file"
      ] }
  }
}
```

In `symbols` privacy mode, `head` is replaced by the symbol list, so no raw code
is sent.

### 3.5 Step 5: build the map (code only)

- `core`: score ≥ 2.5. `supporting`: score ≥ 1.5. Keep at most 10 files in total.
- `blocked`: skim noul < 0.15, **and** the file was not named in the prompt,
  **and** it is not a project context file (README, manifest, config, entry
  point: matched by filename rules in code).
- Anything in between is neither suggested nor blocked.
- The map is saved to `~/.claude/bouncer/sessions/<session_id>.json`.

### 3.6 Step 6: inject

The UserPromptSubmit hook prints:

```json
{ "hookSpecificOutput": { "hookEventName": "UserPromptSubmit",
  "additionalContext": "Bouncer file map for this task (TypeSafe Jev, 412 files scanned):\ncore: src/auth/login.ts, src/middleware/index.ts\nsupporting: src/auth/session.ts, src/config/limits.ts, test/auth/login.test.ts\nStart with these. Avoid broad exploration; reads of files judged unrelated will be skipped. Ignore this map if it clearly doesn't fit the task." } }
```

### 3.7 The read gate (PreToolUse on `Read`)

The gate makes no network call, so it adds no latency to reads.

| Situation | Result |
|---|---|
| Bouncer off, or no map for this turn | allow |
| File in `core` / `supporting` | allow |
| File not scanned (new file, outside repo, filtered out) | allow |
| File ≤ 30 lines | allow |
| File in `blocked`, first attempt | **skip**, with the note: "Bouncer: `src/billing/invoice.ts` looks unrelated to this task. Read it again if you really need it." |
| File in `blocked`, second attempt | allow (override), logged |

---

## 4. Settings

These are optional. The defaults are meant to just work.

`~/.claude/bouncer/config.json` or `<repo>/.claude/bouncer.json`:

```json
{
  "privacy": "content",
  "maxSuggested": 10,
  "closeLookTopK": 20,
  "blockBelow": 0.15,
  "tinyFileLines": 30,
  "timeoutMs": 8000,
  "model": "jev-latest"
}
```

- `privacy`: `content` sends paths, symbols and the first 40 lines of the top 20
  files. `symbols` sends paths and symbol names only.
- **Your prompt text is sent to TypeSafe in both modes.**
- The API key is read only from `TYPESAFE_API_KEY`.

---

## 5. Failure behaviour: never breaks Claude

| Problem | Result |
|---|---|
| No API key | `/bouncer:on` says so; nothing is gated |
| Jev slow (over 8s) or down | This prompt runs without a map; gate allows everything |
| Partial batch failure | Map built from the batches that succeeded; unscored files are allowed |
| Script crash | Exit 0, no output; Claude continues normally |

---

## 6. Stats (`/bouncer:stats`)

```
Bouncer — this session
  prompts mapped        6   (2 reused map, 1 no-code)
  files scanned     2,470   (Jev cost ≈ $0.006, avg 1.2s per map)
  suggested files      31   → Claude read 24 of them
  reads skipped         9   (≈ 38k tokens not loaded) · overridden 1
  reads outside map     7
```

Two numbers to watch:
- **Override rate** (skipped reads that Claude re-requested). Above ~20% means
  `blockBelow` is too aggressive.
- **Hit rate** (suggested files Claude actually read). A low hit rate means the
  map isn't useful.

---

## 7. Plugin layout

```
plugins/bouncer/
  .claude-plugin/plugin.json
  commands/  on.md  off.md  map.md  stats.md
  hooks/hooks.json               # UserPromptSubmit → map.mjs, PreToolUse(Read) → gate.mjs
  scripts/  map.mjs  gate.mjs  toggle.mjs  stats.mjs  eval.mjs
  lib/
    files.mjs      # git ls-files, filters, symbol extraction, mtime cache
    jev.mjs        # fetch client, batching, parallel, timeout
    questions.mjs  # builds the Noul/Score requests above
    mapper.mjs     # skim → close look → map (pure logic + thresholds)
    gate.mjs       # read decision (pure)
    state.mjs      # session files, atomic writes
    config.mjs  log.mjs
  bench/tasks.jsonl              # labelled {repo, task, needed_files[]} for eval
  test/*.test.mjs                # node --test, mocked fetch
  README.md
```

Node 20+, zero dependencies. This replaces the `plugins/my-plugin` placeholder.

---

## 8. Build phases

Each phase ends with a concrete output you can check.

### Phase 0: Spike (throwaway, ~1 hour)
- Measure Jev latency for a 300-question skim batch and a 20-question close look.
- Confirm that `UserPromptSubmit` receives `/bouncer:on` as raw prompt text with
  a `session_id`. This is how the toggle binds to a session. Fallback: toggle
  per repo instead of per session.
- **Output:** latency numbers, and a go/no-go. The target is a map in under 3s
  for a repo of about 1,000 files.

### Phase 1: Offline mapper
- `files.mjs`, `jev.mjs`, `questions.mjs`, `mapper.mjs`, plus a CLI:
  `node scripts/map.mjs --task "..." --repo .`
- **Output:** the map printed to the terminal for any task and repo. Plus
  `eval.mjs` over about 15 labelled tasks on 2–3 real repos, reporting
  **recall of needed files in the suggested list** (target ≥ 80%) and
  **needed files wrongly blocked** (target 0).

### Phase 2: `/bouncer:on` + context injection
- Commands, toggle, UserPromptSubmit hook, follow-up detection (3.1).
- **Output:** in a real session, after `/bouncer:on` each prompt shows the file
  map and Claude starts from it. There is no gating yet.

### Phase 3: Read gate
- `gate.mjs` with the retry override.
- **Output:** a skipped read shows the note, and a second read passes. Normal
  reads have no added latency.

### Phase 4: Stats + packaging
- `/bouncer:stats`, `/bouncer:map`, README, marketplace entry, `claude plugin validate .`
- **Output:** installable plugin; stats show reads skipped and tokens saved.

### Phase 5: Prove the saving
- Run the same 10 tasks with Bouncer off and on, and compare total Claude tokens
  (from the session logs) and task success.
- **Output:** a before/after table, for example "−35% tokens, same success on
  10/10". If there's no real saving, tune the thresholds or stop.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| Map misses a needed file | Unscored and middle-scored files are never blocked; Claude can still read anything; retry override |
| Map latency annoys the user | Parallel batches, mtime cache, reuse map on follow-ups, 8s hard cap |
| Huge repos | Directory pass first; skip files over 1 MB; cap at 5,000 candidates |
| Jev reads literally | Task = original prompt plus follow-ups; questions worded directly, as the jaggedness page advises |
| File text steers Jev (injection) | Only the top 20 files send their head; worst case is one wrong suggestion |
| Claude ignores the map | Phase 5 measures the hit rate; the wording of the injected note is tunable |
| Subagents | v1 gates only the main session's reads; subagent reads are allowed |

## 10. Out of scope (v1)

- Gating Bash `cat`/`sed`, and filtering Grep output.
- Cross-session score caching (the symbol cache is cross-session).
- Any UI beyond `/bouncer:stats`.
