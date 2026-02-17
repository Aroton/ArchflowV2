---
description: Explore codebase and produce persistent context references
argument-hint: "[focus area]"
---

# Explore Codebase

Explore the codebase and produce reference documents in `.archflow/context/`. These persist across tasks and sessions. Run again to refresh.

## Process

### Step 1: Setup

Create `.archflow/context/` if it doesn't exist.

If context docs already exist, ask the user:

```
╔══════════════════════════════════════════════════════════╗
║  Existing context docs found.                           ║
║  Refreshing will overwrite them. Proceed? (y/n)         ║
╚══════════════════════════════════════════════════════════╝
```

### Step 2: Parallel Exploration

Launch 3 sub-agents in parallel (`subagent_type: "general-purpose"`). Each explores a different aspect of the codebase and writes its output file directly.

**Agent 1 -- Structure & Architecture:**
Explore the codebase structure. Map out:
- Top-level directory organization and what each dir contains
- Key entry points (main files, index files, route definitions)
- How the application is wired together (imports, dependency flow)
- Build system and configuration files
Write the results to `.archflow/context/architecture.md` as a clean, scannable reference doc with file paths and code snippets. Return only the file path.

**Agent 2 -- Patterns & Conventions:**
Explore the codebase for patterns and conventions:
- Naming conventions (files, functions, variables, components)
- Common patterns used (error handling, state management, data access)
- Testing patterns (what framework, how tests are organized, fixtures)
- Code style (formatting, imports organization, module structure)
Write the results to `.archflow/context/patterns.md` with concrete examples from the code. Return only the file path.

**Agent 3 -- Dependencies & Integrations:**
Explore external dependencies and integrations:
- Key dependencies and what they're used for
- External service integrations (APIs, databases, auth providers)
- Environment configuration (env vars, config files)
- Dev tooling (linters, formatters, CI/CD)
Write the results to `.archflow/context/dependencies.md`. Return only the file path.

If $ARGUMENTS contains a focus area, adjust the agent prompts to dig deeper into that area.

### Step 3: Commit

Stage the `.archflow/context/` files and commit:

```
Archflow: Explore Codebase Context
```

### Step 4: Present Results

Summarize what was found. Tell the user:

> Context docs written to `.archflow/context/`. These will be used automatically by other arch commands.
>
> Files:
> - `.archflow/context/architecture.md`
> - `.archflow/context/patterns.md`
> - `.archflow/context/dependencies.md`
>
> Run `/arch:explore [focus]` anytime to refresh or dive deeper into a specific area.
