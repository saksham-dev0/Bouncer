# Bouncer

TypeSafe's Jev model picks the files each prompt actually needs, and irrelevant
reads get skipped, so Claude stops reading half your repo.

## Install

```
/plugin marketplace add saksham-dev0/claude-plugin
/plugin install bouncer@my-marketplace
```

Then set your TypeSafe API key (get one at https://console.typesafe.ai/keys). Pick one:

**Just this project.** Create `.claude/settings.local.json` in the project root:

```json
{
  "env": { "TYPESAFE_API_KEY": "ts_..." }
}
```

Claude Code passes `env` to Bouncer's hooks. `settings.local.json` is meant to
stay on your machine. Check that it is git-ignored before you add a key:

```bash
git check-ignore .claude/settings.local.json || echo ".claude/settings.local.json" >> .gitignore
```

Never put the key in `.claude/settings.json`, because that file is usually committed.

**Every project.** Add `export TYPESAFE_API_KEY="ts_..."` to `~/.zshrc` (or
`~/.bashrc`) and restart the terminal.

Restart Claude Code after setting the key.

## Use

| Command | What it does |
|---|---|
| `/bouncer:on` | Turn on for this session. Every prompt gets a file map. |
| `/bouncer:off` | Turn off. |
| `/bouncer:map <task>` | One prompt with a file map, without turning it on. |
| `/bouncer:stats` | Reads skipped, tokens saved, cost, override rate. |

When Bouncer is on, each prompt shows a line like
`Bouncer: 412 files scanned → 5 picked (1.1s)`. Claude is told which files are
core or supporting.

If Claude reads a file Jev judged unrelated, the read is skipped with a note.
Reading the same file again lets it through. Short follow-ups like "yes" reuse
the current map.

## What leaves your machine

- **Always sent to TypeSafe:** your prompt text, file paths, and function or class names.
- **With `privacy: "content"` (the default):** also the first 40 lines of the top ~20 candidate files.
- **With `privacy: "symbols"`:** no file contents at all.

## Settings

All settings are optional. Put them in `~/.claude/bouncer/config.json` or
`<repo>/.claude/bouncer.json`:

```json
{ "privacy": "content", "maxSuggested": 10, "closeLookTopK": 20, "blockBelow": 0.15,
  "tinyFileLines": 30, "timeoutMs": 8000, "model": "jev-latest" }
```

`BOUNCER_PRIVACY=symbols` overrides the privacy setting for one shell.

## Safety

Bouncer fails open:
- If there is no key, TypeSafe is down or anything crashes, nothing is blocked.
- Files named in your prompt, project-wide files (README, manifests, entry points)
  and tiny files are never blocked.
- Subagent reads are never gated.

The log is kept in `~/.claude/bouncer/log.jsonl`.

## Development

```bash
node --test 'plugins/bouncer/test/*.test.mjs'                               # unit + hook tests (fake Jev, no key needed)
node plugins/bouncer/scripts/map-cli.mjs --task "..." --repo .              # live map for one task
node plugins/bouncer/scripts/eval.mjs                                       # recall / wrong-block check on bench/tasks.jsonl
claude --plugin-dir ./plugins/bouncer                                       # run Claude Code with the local copy
```
