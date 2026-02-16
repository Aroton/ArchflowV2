# ArchFlow Process

## Overall Workflow

```mermaid
flowchart LR
    Start([Start]) --> Explore["/arch:explore"]
    Explore --> PRD["/arch:prd"]
    PRD --> Design["/arch:design"]
    Design --> Phase["/arch:phase 1..N"]
    Phase --> Done([Done])

    style Start fill:#4CAF50,stroke:#333,color:#fff
    style Done fill:#4CAF50,stroke:#333,color:#fff
```

Each command has a human review gate -- nothing proceeds without your approval. See command details below for full flows.

```mermaid
flowchart TD
    subgraph "Each Command Internally"
        Read[Read .archflow/ context] --> Agents[Sub-agents<br/>explore, research, plan]
        Agents --> Output[Write .archflow/ doc]
        Output --> Review{{Human Review}}
        Review -->|Feedback| Agents
        Review -->|Approved| Next[Next command]
    end

    subgraph "Phase Loop (/arch:phase)"
        Design2[Design phase] --> Impl[Implement]
        Impl --> Verify{{Human Verifies}}
        Verify -->|Issues| Impl
        Verify -->|Verified| Log[Write impl log]
        Log --> More{More phases?}
        More -->|Yes| Design2
        More -->|No| Done2([Task complete])
    end

    style Review fill:#ffd700,stroke:#333,color:#000
    style Verify fill:#ffd700,stroke:#333,color:#000
```

---

## File System

```mermaid
flowchart LR
    subgraph ".archflow/ (gitignored)"
        subgraph "context/"
            A1[architecture.md]
            A2[patterns.md]
            A3[dependencies.md]
        end
        subgraph "tasks/my-feature/"
            B1[prd.md]
            B2[architecture.md]
            subgraph "phases/"
                C1[phase-1-setup.md]
                C1L[phase-1-setup-log.md]
                C2[phase-2-core.md]
                C2L[phase-2-core-log.md]
                C3[phase-3-polish.md]
            end
        end
        subgraph "tasks/other-task/"
            D1[prd.md]
            D2[architecture.md]
            D3[phases/...]
        end
    end

    style A1 fill:#e3f2fd,stroke:#1565c0
    style A2 fill:#e3f2fd,stroke:#1565c0
    style A3 fill:#e3f2fd,stroke:#1565c0
    style B1 fill:#e8f5e9,stroke:#2e7d32
    style B2 fill:#e8f5e9,stroke:#2e7d32
    style C1 fill:#fff3e0,stroke:#e65100
    style C1L fill:#ffe0b2,stroke:#e65100
    style C2 fill:#fff3e0,stroke:#e65100
    style C2L fill:#ffe0b2,stroke:#e65100
    style C3 fill:#fff3e0,stroke:#e65100
    style D1 fill:#f3e5f5,stroke:#6a1b9a
    style D2 fill:#f3e5f5,stroke:#6a1b9a
    style D3 fill:#f3e5f5,stroke:#6a1b9a
```

- **Blue**: Shared context (reused across all tasks)
- **Green**: Task-level docs (PRD, architecture)
- **Orange**: Phase design docs + companion log files (log written on phase completion, read by subsequent phases)
- **Purple**: Independent tasks (fully isolated from each other)

---

## Context Passing

Every command (except `/arch:explore`, which creates context) follows this pattern:

1. **Main agent reads key `.archflow/` files** -- for control flow decisions (does the PRD exist? what's the phase status?) and to gather context
2. **Passes relevant context to sub-agents** -- when spawning Explore, Research, or Plan agents, the main agent includes the necessary context in each agent's prompt

No separate context-gathering step is needed. The main agent reads the files directly and includes the relevant parts when spawning downstream agents.

**What each command reads:**

| Command | Files Read | Passed to Sub-Agents |
|---------|-----------|---------------------|
| `/arch:prd` | prd.md (check if exists), context/* | User requirements + codebase context summary |
| `/arch:design` | prd.md (required), architecture.md (if revising), context/* | PRD requirements/constraints + codebase context |
| `/arch:phase` | architecture.md (required), phase-N doc (check status), ALL prior phase docs + ALL prior log files, context/* | Phase definition + prior phase learnings (decisions, patterns, interfaces, gotchas) |
| `/arch:status` | architecture.md, phase docs (for status) | N/A (no sub-agents) |

---

## Command Details

### `/arch:explore`

```mermaid
flowchart TD
    E0["/arch:explore"] --> E1{Context docs<br/>exist?}
    E1 -->|Yes| E1a{{Ask: Refresh?}}
    E1a -->|No| E_done
    E1a -->|Yes| E2
    E1 -->|No| E2

    subgraph "Parallel Explore Agents"
        E2[Agent 1<br/>Structure & Architecture]
        E3[Agent 2<br/>Patterns & Conventions]
        E4[Agent 3<br/>Dependencies & Integrations]
    end

    E2 --> E5[Write architecture.md]
    E3 --> E6[Write patterns.md]
    E4 --> E7[Write dependencies.md]

    E5 --> E_done[Present summary to user]
    E6 --> E_done
    E7 --> E_done

    style E2 fill:#e3f2fd,stroke:#1565c0
    style E3 fill:#e3f2fd,stroke:#1565c0
    style E4 fill:#e3f2fd,stroke:#1565c0
    style E1a fill:#ffd700,stroke:#333,color:#000
```

**Agents**: 3x general-purpose (parallel, explore + write)
**Output**: `.archflow/context/{architecture,patterns,dependencies}.md`
**When to run**: Before starting tasks on an existing codebase. Re-run after major refactors.

---

### `/arch:prd <task-name>`

```mermaid
flowchart TD
    P0["/arch:prd my-feature"] --> P_read[Read prd.md + context/*<br/>if they exist]
    P_read --> P1{PRD exists?}
    P1 -->|Yes| P1a{{Revise or<br/>start fresh?}}
    P1a --> P2
    P1 -->|No| P2

    P2[Gather Requirements] --> P2a{{Conversation<br/>2-4 rounds}}
    P2a --> P3

    subgraph "Parallel Research Agents"
        P3[Agent 1<br/>Domain Research]
        P4[Agent 2<br/>Competitive Landscape]
        P5[Agent 3<br/>Technical Research]
    end

    P3 --> P6
    P4 --> P6
    P5 --> P6

    P6[Plan Agent<br/>Design PRD structure] --> P7[Write prd.md]
    P7 --> P8{{Human reviews<br/>PRD in editor}}
    P8 -->|Changes| P2
    P8 -->|Approved| P9["/arch:design my-feature"]

    style P3 fill:#fff3e0,stroke:#e65100
    style P4 fill:#fff3e0,stroke:#e65100
    style P5 fill:#fff3e0,stroke:#e65100
    style P6 fill:#e8eaf6,stroke:#283593
    style P2a fill:#ffd700,stroke:#333,color:#000
    style P1a fill:#ffd700,stroke:#333,color:#000
    style P8 fill:#ffd700,stroke:#333,color:#000
```

**Agents**: 2-3x general-purpose (parallel research) + 1x general-purpose (plan + write PRD)
**Output**: `.archflow/tasks/{task}/prd.md`
**Context read**: `.archflow/context/*` (if available)

---

### `/arch:design <task-name>`

```mermaid
flowchart TD
    D0["/arch:design my-feature"] --> D_read[Read prd.md + architecture.md<br/>+ context/*]
    D_read --> D_check{PRD exists?}
    D_check -->|No| D_stop([Stop: run /arch:prd first])
    D_check -->|Yes| D1

    subgraph "Parallel Exploration"
        D1[Explore Agent<br/>Relevant code analysis]
        D2[Research Agent<br/>Architecture patterns]
    end

    D1 --> D3
    D2 --> D3

    D3{{Discuss key decisions<br/>with user}} --> D4

    D4[Plan Agent<br/>Design full architecture] --> D5[Write architecture.md]

    D5 --> D6{{Human reviews<br/>architecture in editor}}
    D6 -->|Changes| D3
    D6 -->|Approved| D7["/arch:phase my-feature 1"]

    style D1 fill:#e3f2fd,stroke:#1565c0
    style D2 fill:#fff3e0,stroke:#e65100
    style D4 fill:#e8eaf6,stroke:#283593
    style D3 fill:#ffd700,stroke:#333,color:#000
    style D6 fill:#ffd700,stroke:#333,color:#000
    style D_stop fill:#ef5350,stroke:#333,color:#fff
```

**Agents**: 1x Explore + 0-1x general-purpose (research) + 1x general-purpose (plan + write architecture)
**Output**: `.archflow/tasks/{task}/architecture.md`
**Context read**: `.archflow/tasks/{task}/prd.md` + `.archflow/context/*`

---

### `/arch:phase <task-name> N`

```mermaid
flowchart TD
    PH0["/arch:phase my-feature 2"] --> PH_read[Read architecture.md +<br/>phase-N doc + prior phases<br/>+ prior logs + context/*]
    PH_read --> PH_check{Architecture<br/>exists?}
    PH_check -->|No| PH_stop([Stop: run /arch:design first])
    PH_check -->|Yes| PH1{Phase doc<br/>exists?}

    PH1 -->|"Status: COMPLETE"| PH_done([Already done.<br/>Suggest next phase.])
    PH1 -->|"Status: IN PROGRESS"| PH_resume

    subgraph "Resume Flow"
        PH_resume[Explore Agent<br/>Check implementation progress] --> PH_report{{Report progress.<br/>Continue?}}
        PH_report --> PH_impl
    end

    PH1 -->|"Status: DESIGNED"| PH_ask{{Implement or<br/>revise?}}
    PH_ask -->|Revise| PH2
    PH_ask -->|Implement| PH_impl

    PH1 -->|No doc| PH2

    subgraph "Parallel Explore + Research"
        PH2[Explore Agent<br/>Current codebase state]
        PH3[Research Agent<br/>Technical best practices]
    end

    PH2 --> PH4
    PH3 --> PH4

    PH4[Plan Agent<br/>Detailed phase plan] --> PH5[Write phase-N-name.md<br/>Status: DESIGNED]

    PH5 --> PH6{{Human reviews<br/>phase design in editor}}
    PH6 -->|Feedback| PH4
    PH6 -->|"implement"| PH_impl

    subgraph "Parallel Implementation"
        PH_impl[Analyze steps for independence] --> PH_parallel[Fan out to parallel<br/>sub-agents where possible]
        PH_parallel --> PH_sequential[Sequential steps<br/>that depend on prior output]
    end

    PH_sequential --> PH_verify

    subgraph "Verification"
        PH_verify[Present testing steps<br/>to user] --> PH_human_test{{Human runs tests<br/>and verifies}}
        PH_human_test -->|Issues found| PH_fix[Fix issues] --> PH_verify
        PH_human_test -->|All verified| PH_log
    end

    subgraph "Completion"
        PH_log[Write phase-N-slug-log.md<br/>decisions, patterns, gotchas] --> PH_parent[Update architecture.md<br/>+ prd.md if deviations]
        PH_parent --> PH_update[Update status → COMPLETE]
    end

    PH_update --> PH_next["/arch:phase my-feature N+1"]

    style PH2 fill:#e3f2fd,stroke:#1565c0
    style PH3 fill:#fff3e0,stroke:#e65100
    style PH4 fill:#e8eaf6,stroke:#283593
    style PH_resume fill:#e3f2fd,stroke:#1565c0
    style PH6 fill:#ffd700,stroke:#333,color:#000
    style PH_ask fill:#ffd700,stroke:#333,color:#000
    style PH_report fill:#ffd700,stroke:#333,color:#000
    style PH_human_test fill:#ffd700,stroke:#333,color:#000
    style PH_stop fill:#ef5350,stroke:#333,color:#fff
    style PH_done fill:#4CAF50,stroke:#333,color:#fff
```

**Agents**: 1x Explore + 0-1x general-purpose (research) + 1x general-purpose (plan + write phase doc) + Nx general-purpose (parallel implementation)
**Output**: `.archflow/tasks/{task}/phases/phase-N-{slug}.md` + `phase-N-{slug}-log.md` + actual code
**Context read**: architecture.md + prd.md + ALL prior phase docs + ALL prior log files + `.archflow/context/*`

---

## Sub-Agent Map

```mermaid
flowchart LR
    subgraph "Agent Types Used"
        EX["Explore<br/>(codebase analysis)"]
        GP["general-purpose<br/>(research, writing,<br/>implementation)"]
    end

    subgraph "Commands"
        explore["/arch:explore"]
        prd["/arch:prd"]
        design["/arch:design"]
        phase["/arch:phase"]
        status["/arch:status"]
    end

    explore ---|"3x parallel<br/>(explore + write files)"| GP
    prd ---|"2-3x parallel<br/>(research)"| GP
    prd ---|"1x sequential<br/>(plan + write PRD)"| GP
    design ---|1x| EX
    design ---|"0-1x research"| GP
    design ---|"1x sequential<br/>(plan + write arch)"| GP
    phase ---|1x design| EX
    phase ---|"0-1x research"| GP
    phase ---|"1x sequential<br/>(plan + write phase doc)"| GP
    phase ---|"Nx parallel<br/>(implementation)"| GP

    style EX fill:#e3f2fd,stroke:#1565c0
    style GP fill:#fff3e0,stroke:#e65100
```

---

## Context Flow Between Sessions

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude Code
    participant FS as .archflow/

    Note over U,FS: Session 1: Explore + PRD
    U->>C: /arch:explore
    C->>FS: Write context/*.md

    U->>C: /arch:prd my-feature
    C->>FS: Read context/*.md
    C->>U: Gather requirements (2-4 rounds)
    C->>FS: Write tasks/my-feature/prd.md
    U->>U: Review PRD in editor

    Note over U,FS: Session 2: Architecture
    U->>C: /arch:design my-feature
    C->>FS: Read context/* + prd.md
    C->>U: Discuss key decisions
    C->>FS: Write tasks/my-feature/architecture.md
    U->>U: Review architecture in editor

    Note over U,FS: Session 3: Phase 1
    U->>C: /arch:phase my-feature 1
    C->>FS: Read context/* + prd + arch
    C->>FS: Write tasks/my-feature/phases/phase-1-setup.md
    U->>U: Review phase design
    U->>C: implement
    C->>C: Write code (parallel sub-agents)
    C->>U: Present testing/verification steps
    U->>C: Verification results
    C->>FS: Write phase-1-setup-log.md
    C->>FS: Update architecture.md + prd.md (if deviations)
    C->>FS: Update phase-1 → COMPLETE

    Note over U,FS: Session 4: Phase 2
    U->>C: /arch:phase my-feature 2
    C->>FS: Read context/* + prd + arch + phase-1 + phase-1-log
    Note right of C: Phase 1 learnings → avoids repeating mistakes
    C->>FS: Write phases/phase-2-core.md
    U->>U: Review phase design
    U->>C: implement
    C->>C: Write code (parallel sub-agents)
    C->>U: Present testing/verification steps
    U->>C: Verification results
    C->>FS: Write phase-2-core-log.md
    C->>FS: Update phase-2 → COMPLETE
```

Each session only reads what it needs. The `.archflow/` docs **are** the context -- no separate state files.

---

## Phase State Machine

```mermaid
stateDiagram-v2
    [*] --> NO_DOC: /arch:phase task N

    NO_DOC --> DESIGNED: Explore + Plan agents → write phase doc
    DESIGNED --> DESIGNED: User requests revisions
    DESIGNED --> IN_PROGRESS: User says "implement"
    IN_PROGRESS --> IN_PROGRESS: Context lost → resume from doc
    IN_PROGRESS --> IN_PROGRESS: Issues found during verification → fix
    IN_PROGRESS --> COMPLETE: Human verifies → impl log written
    COMPLETE --> [*]: Suggest next phase

    note right of NO_DOC: First time running this phase
    note right of DESIGNED: Human reviews in editor
    note right of IN_PROGRESS: Code being written + human verification
    note right of COMPLETE: Impl log written + parent docs updated
```

---

## Implementation Log (Inter-Phase Learning)

Each completed phase gets a companion **log file** at `phase-N-{slug}-log.md`. This is how phases learn from each other.

```markdown
## Implementation Log

### Decisions Made
- Chose Zod over Joi for validation: Zod has native TypeScript inference, Joi required separate type definitions
- Used a single `errors` table instead of per-module tables: simpler queries, one place to check

### Deviations from Plan
- Planned separate `AuthService` class, built as plain functions instead: the class had no state, functions were simpler and easier to test
- Added `retry` wrapper to API client: external service was flaky during testing, needed exponential backoff

### Patterns Established
- Error handling: all service functions return `Result<T, AppError>` -- no thrown exceptions past the service boundary
- DB queries: use repository pattern in `src/repos/`, one file per entity, raw SQL via Kysely

### Gotchas
- SQLite doesn't enforce VARCHAR length -- validation must happen in application code
- `bcrypt.hash()` returns a different length depending on the salt rounds config -- the `password_hash` column needs VARCHAR(72) minimum

### Key Interfaces
- `src/repos/user-repo.ts`: exports `createUser()`, `findByEmail()`, `findById()` -- phase 2 auth flow should use these, not query directly
- `src/lib/result.ts`: exports `Result<T, E>`, `ok()`, `err()` -- all service functions must use this pattern
```

**How it flows:**
- Phase 1 completes → log written to `phase-1-setup-log.md` → architecture.md and prd.md updated if deviations occurred
- Phase 2 starts → reads ALL prior phase docs AND their log files
- Phase 2's Plan Agent receives these learnings as input → avoids repeating mistakes, reuses established patterns, builds on actual interfaces (not just planned ones)
- The architecture doc stays accurate because each phase updates it on completion — remaining phase definitions reflect reality, not the original guess

Separate file keeps the design doc clean and the log focused. The naming convention (`-log.md` suffix) makes it easy to glob for all logs.

---

## Verification Flow

After implementation, before marking COMPLETE, the phase goes through verification:

```mermaid
flowchart TD
    Impl[Implementation done] --> Present[Present testing steps<br/>to human]
    Present --> Steps["Step-by-step verification:<br/>1. Run specific commands<br/>2. Check specific behaviors<br/>3. Verify edge cases"]
    Steps --> Human{{Human executes<br/>and reports results}}
    Human -->|"All pass"| Log[Write Implementation Log]
    Human -->|"Issues found"| Fix[Fix reported issues]
    Fix --> Present

    style Human fill:#ffd700,stroke:#333,color:#000
```

Testing steps are **specific and actionable** -- not "verify it works" but concrete commands, URLs to check, behaviors to observe. The human acts as the verification layer, and any issues feed back into the implementation before the phase closes.

---

## Task Independence

```mermaid
flowchart TD
    subgraph "Shared (read-only reference)"
        CTX[".archflow/context/"]
    end

    subgraph "Task A: auth-system"
        A_PRD[prd.md] --> A_ARCH[architecture.md]
        A_ARCH --> A_P1[phase-1]
        A_ARCH --> A_P2[phase-2]
    end

    subgraph "Task B: dashboard"
        B_PRD[prd.md] --> B_ARCH[architecture.md]
        B_ARCH --> B_P1[phase-1]
        B_ARCH --> B_P2[phase-2]
        B_ARCH --> B_P3[phase-3]
    end

    CTX -.->|reads| A_PRD
    CTX -.->|reads| B_PRD

    style CTX fill:#e3f2fd,stroke:#1565c0
    style A_PRD fill:#e8f5e9,stroke:#2e7d32
    style A_ARCH fill:#e8f5e9,stroke:#2e7d32
    style A_P1 fill:#e8f5e9,stroke:#2e7d32
    style A_P2 fill:#e8f5e9,stroke:#2e7d32
    style B_PRD fill:#f3e5f5,stroke:#6a1b9a
    style B_ARCH fill:#f3e5f5,stroke:#6a1b9a
    style B_P1 fill:#f3e5f5,stroke:#6a1b9a
    style B_P2 fill:#f3e5f5,stroke:#6a1b9a
    style B_P3 fill:#f3e5f5,stroke:#6a1b9a
```

Tasks never read each other's files. Deleting one task has zero impact on others. Context docs are shared but read-only -- they inform, they don't couple.
