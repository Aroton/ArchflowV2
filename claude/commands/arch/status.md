---
description: Show project status and suggest next action
argument-hint: "[task-name]"
---

# Project Status

Show the status of ArchFlow tasks.

## Process

### Step 1: Discover Tasks

Check if `.archflow/` exists. If not:
> No ArchFlow tasks found. Run `/arch:prd <task-name>` to start a new task.

If `.archflow/tasks/` exists, list all task directories.

If $ARGUMENTS specifies a task name, focus on that task only.

### Step 2: Report Status Per Task

For each task (or the specified task), check what exists:
- `.archflow/tasks/{task}/prd.md` → PRD done
- `.archflow/tasks/{task}/architecture.md` → Architecture done (parse Progress table)
- `.archflow/tasks/{task}/phases/*.md` → Read each for status

Present a summary:

```
## ArchFlow Status

### {task-name}
PRD: Done
Architecture: Done
Phases:
| # | Name | Status |
|---|------|--------|
| 1 | ... | Complete |
| 2 | ... | In Progress |
| 3 | ... | Not Started |

**Next**: `/arch:phase {task} 3`
```

If multiple tasks exist, show a compact summary of each.

### Step 3: Context Info

If `.archflow/context/` exists, note when the context docs were last updated.

### Step 4: Show Recent Activity

Check `git log --oneline -5` for recent commits.

### Step 5: Suggest Next Action

Based on current state of the specified (or most active) task, suggest exactly one next action:
- No PRD → `/arch:prd {task}`
- No architecture → `/arch:design {task}`
- Phases remaining → `/arch:phase {task} N`
- All phases complete → "Task {task} is complete!"
- No context docs → Consider running `/arch:explore` first
