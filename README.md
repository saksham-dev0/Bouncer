# my-marketplace

Claude Code plugin marketplace.

## Install

```
/plugin marketplace add YOUR_GITHUB/claude-plugin
/plugin install my-plugin@my-marketplace
```

## Local development

```
claude plugin validate .
/plugin marketplace add ./path/to/claude-plugin
/plugin install my-plugin@my-marketplace
```

## Layout

```
.claude-plugin/marketplace.json   # marketplace catalog
plugins/my-plugin/
  .claude-plugin/plugin.json      # plugin manifest
  commands/                       # slash commands
  agents/                         # subagents
  skills/                         # skills (one dir per skill, SKILL.md)
  hooks/hooks.json                # hook config
  scripts/                        # hook scripts
```
