# ArchFlow constitution

Each numbered Markdown file is one repository-wide policy rule. YAML frontmatter carries its stable identity and positive version; the prose body is the normative rule text. Rule IDs are append-only across approved revisions: change content or status only with a higher version, deprecate instead of deleting, and never reactivate a deprecated ID.

Tasks pin these files from an immutable, human-approved policy-base commit. A task branch cannot amend its own governing constitution.


The shipped triggers cover access control, public contracts, cryptography/secrets, workflow policy, and material changes to approved plans. Public means externally consumed, not merely a class method's visibility. Plan maintenance uses authenticated before-and-after comparison: meaning-preserving changes can advance automatically while material changes require approval. SQL path approval remains in the configuration template.

Existing tasks keep their pinned policy. Adopting these defaults requires an explicit policy/configuration update; a template refresh must not silently delete custom rules or clear an open gate.
