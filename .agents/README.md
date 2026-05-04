# .agents Directory

This directory contains agent configuration and skills for OpenAI Codex CLI.

## Structure

```
.agents/
  config.toml     # Main configuration file
  skills/         # Skill definitions
    skill-name/
      SKILL.md    # Skill instructions
      README.md   # Optional usage summary for project skills
      scripts/    # Optional scripts
      docs/       # Optional documentation
  README.md       # This file
```

## Configuration

The `config.toml` file controls:
- Model selection
- Approval policies
- Sandbox modes
- MCP server connections
- Skills configuration

## Skills

Skills are invoked using `$skill-name` syntax. Each skill has:
- YAML frontmatter with metadata
- Trigger and skip conditions
- Commands and examples

Project-specific skills:

- `frontend-backend-functional-test`: validates local or hosted frontend/backend URLs using `npm run test:functional` and only implemented functionality.
- `render-hosting-control`: uses the Render CLI to validate `render.yaml`, trigger deploys, list deploys, fetch logs, and run FreeWheel remote checks.

## Documentation

- Main instructions: `AGENTS.md` (project root)
- Local overrides: `.codex/AGENTS.override.md` (gitignored)
- Claude Flow: https://github.com/ruvnet/claude-flow
