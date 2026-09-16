# ArchFlow constitution

Each numbered Markdown file is one repository-wide policy rule. Shipped rules live in `default/`; repository-specific rules and replacements live in `custom/`. YAML frontmatter carries its stable identity and positive version; the prose body is the normative rule text. Rule IDs are append-only across approved revisions: change content or status only with a higher version, deprecate instead of deleting, and never reactivate a deprecated ID.

Tasks pin these files from an immutable, human-approved policy-base commit. A task branch cannot amend its own governing constitution.

## Automated review and human review

Every active rule receives automated compliance review, whether or not it has a `review_trigger`. The rule body tells the AI what must remain true. The optional `review_trigger` is specifically a **human-review trigger**: it adds a user decision when its condition matches; it does not turn automated review on or off.

| Rule configuration | Automated review | Human review |
| --- | --- | --- |
| Active rule without `review_trigger` | Always; remediate supported failures | Only for an unresolved blocker after remediation |
| Active rule with `review_trigger` | Always; evaluate compliance and the trigger separately | Required when the human-review condition matches |
| Deprecated rule | Not active | No new review obligation |

The default human decisions are the initial PRD and overall design, material changes to their approved decisions, and SQL/database changes. The constitution declares two triggers: material plan amendments and changes to SQL-backed database behavior (including embedded queries, ORM operations, and schema/data migrations). The configuration template independently matches every changed `*.sql` file. Plan maintenance uses authenticated before-and-after comparison: meaning-preserving updates can advance automatically.

Access control, public contracts, cryptography/secrets, and workflow policy remain active engineering rules, reviewed and remediated automatically. Their historical `human-approval-for-...` IDs are preserved for durable identity; they no longer declare human triggers. Failed compliance is agent work first and escalates only when remediation is exhausted. Required review or verification that cannot be completed and uncertain workflow authority remain blockers.

To add a repository-specific human boundary, add a numbered rule in `custom/` with an observable `review_trigger`. For example:

```md
---
id: human-review-for-billing
version: 1
status: active
review_trigger: The implementation changes how an invoice total or customer charge is calculated.
---
Billing calculations must match the agreed pricing and rounding policy.
```

A matching custom trigger requires a human even when automatic reviewers find no defect. Omitting a trigger retains automatic compliance review without requesting routine approval.

Existing tasks keep their pinned policy. Adopting these defaults requires an explicit policy/configuration update; a template refresh must not silently delete custom rules or clear an open gate.

## Defaults, overrides, and updates

Initialization copies the running bundle's defaults into the repository. A custom rule with the same `id` replaces the whole default rule; precedence is by directory, not filename or version. A deprecated custom override suppresses its default. Duplicate IDs within either directory are rejected. When first replacing an effective rule with changed contents, increment its version; later custom edits follow the same version and deprecation rules. A subsequent default refresh never displaces that override, even if the default version becomes higher.

`archflow-local init --force` explicitly refreshes shipped defaults and other scaffold files, including `.archflow/config.yaml`, while preserving `custom/`. In an older flat constitution, this command replaces known shipped filenames with current defaults and moves additional numbered rules into `custom/`. Edits to legacy shipped filenames are reset: copy intentional replacements into `custom/` first if they should survive. Conflicting custom destinations or invalid effective rules are refused before scaffold writes. The report names replaced and moved files. Plain initialization refuses implicit migration. Flat policy at historical commits remains readable; mixing flat rules with split rules is invalid.

Make policy updates on the repository's policy/base branch and commit them before starting affected tasks. Existing tasks retain their pinned policy, task-local config, and pending gate; reinitialization does not repin them. Installing a newer bundle alone does not adopt repository policy. A requested constitution update authorizes committing that scoped change.
