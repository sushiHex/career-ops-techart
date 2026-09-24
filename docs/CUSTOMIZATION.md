# Customization Guide

## Profile (config/profile.yml)

This is the single source of truth for your identity. All modes read from here.

Key sections:
- **candidate**: Name, email, phone, location, LinkedIn, portfolio
- **target_roles**: Your North Star roles and archetypes
- **narrative**: Your headline, exit story, superpowers, proof points
- **compensation**: Target range, minimum, currency
- **location**: Country, timezone, visa status, on-site availability

## Target Roles (modes/_profile.md)

The archetype table in `_profile.md` determines how offers are scored and CVs are framed. Edit the table to match YOUR career targets:

```markdown
| Archetype | Thematic axes | What they buy |
|-----------|---------------|---------------|
| **Your Role 1** | key skills | what they need |
| **Your Role 2** | key skills | what they need |
```

Also update the "Adaptive Framing" table to map YOUR specific projects to each archetype.

## Location (config/location.json)

Where you can work: your home state, the cities inside your commute, metros in your
state that are too far, and whether an onsite role elsewhere should fail or be asked
about. Written by `node setup.mjs`; `presets/README.md` explains each field and walks
through adding a location, with `presets/locations/california-socal.json` as the worked
example. Both location gates and every sweep read this one file.

## Lanes (config/lane-vocab.json)

What counts as in-lane: the title and body terms each scorer rewards and penalises, the
dashboard's lane buckets and the scanner's title filter. Written by `node setup.mjs` from
a preset in `presets/lanes/`, with your keywords layered on. Each section names the tool
that reads it.

## Portals (portals.yml)

Written by `node setup.mjs` from `templates/portals.example.yml`; then customize:

1. **title_filter.positive**: Keywords matching your target roles
2. **title_filter.negative**: Tech stacks or domains to exclude
3. **search_queries**: WebSearch queries for job boards (Ashby, Greenhouse, Lever)
4. **tracked_companies**: Companies to check directly

## CV Template (templates/cv-template.html)

The HTML template uses these design tokens:
- **Fonts**: Space Grotesk (headings) + DM Sans (body) -- self-hosted in `fonts/`
- **Colors**: Cyan primary (`hsl(187,74%,32%)`) + Purple accent (`hsl(270,70%,45%)`)
- **Layout**: Single-column, ATS-optimized

To customize fonts/colors, edit the CSS in the template. Update font files in `fonts/` if switching fonts.

## Negotiation Scripts (modes/_profile.md)

The "Your Negotiation Scripts" section of `modes/_profile.md` (created from
`modes/_profile.template.md` by `node setup.mjs`) provides frameworks for salary discussions. Replace the example scripts with your own:
- Target ranges
- Geographic arbitrage strategy
- Pushback responses

## Hooks (Optional)

Career-ops can integrate with external systems via Claude Code hooks. Example hooks:

```json
{
  "hooks": {
    "SessionStart": [{
      "hooks": [{
        "type": "command",
        "command": "echo 'Career-ops session started'"
      }]
    }]
  }
}
```

Save hooks in `.claude/settings.json` (Claude Code). OpenCode does not support hooks. For equivalent functionality, use custom commands (`.opencode/commands/`) or agents (`.opencode/agents/`) — see https://opencode.ai/docs/commands/.

## States (templates/states.yml)

The canonical states rarely need changing. If you add new states, update:
1. `templates/states.yml`
2. `normalize-statuses.mjs` (alias mappings)
3. `modes/_shared.md` (any references)
