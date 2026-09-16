# Custom constitution rules

Put repository-specific `NN-name.md` rules here. These files are preserved by `archflow-local init --force`.

A custom rule with the same `id` as a default replaces that default completely, including its trigger. A deprecated custom rule suppresses the default. Use a higher version when first changing an effective rule; increment it for subsequent edits and never reactivate a deprecated ID. Default refreshes do not displace an existing override, even when the shipped version becomes higher.

Rules with new IDs add policy. Duplicate IDs within this directory are invalid. See [../README.md](../README.md) for the policy model and task pinning.
