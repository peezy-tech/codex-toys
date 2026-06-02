---
name: setup
description: Use this first when present in a workbench. It initializes the workspace-ops-baseline kit, validates the result with shipped scripts, and retires itself after validation passes.
---

# Workspace Ops Baseline Setup

When this skill exists, the workbench is not fully initialized yet. Run this
setup before doing ordinary repository work.

Use only the shipped script in this skill directory:

```bash
node .agents/skills/setup/scripts/setup.mjs setup
node .agents/skills/setup/scripts/setup.mjs validate --json
node .agents/skills/setup/scripts/setup.mjs retire
```

Do not create or generate replacement validation scripts. If validation fails,
report the failing checks and leave `SKILL.md` in place.
