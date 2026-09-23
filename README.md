# my-marketplace

Claude Code plugin marketplace.

## Plugins

- [`bouncer`](plugins/bouncer/README.md): TypeSafe Jev picks the files each prompt needs and skips irrelevant reads.

## Install

```
/plugin marketplace add saksham-dev0/Bouncer
/plugin install bouncer@my-marketplace
```

## Local development

```
claude plugin validate .
/plugin marketplace add ./path/to/claude-plugin
/plugin install bouncer@my-marketplace
```

## Layout

```
.claude-plugin/marketplace.json   # marketplace catalog
plugins/bouncer/
  .claude-plugin/plugin.json      # plugin manifest
  commands/                       # /bouncer:on, :off, :map, :stats
  hooks/hooks.json                # UserPromptSubmit + PreToolUse(Read)
  scripts/                        # hook entry points and CLIs
  lib/                            # file listing, Jev client, mapper, gate
  test/                           # node --test suites
```
