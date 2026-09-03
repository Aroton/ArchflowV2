# Review Finding Taxonomy

Replaces a single severity scale with three fields.

**Why:** severity is a claim about consequence, so a reviewer who suspects something but can't justify a heavy label files nothing. It also hides confidence — nobody writes `critical` at 40% certainty. And it doesn't tell the executor what to do; a wrong assertion and a style nit both arrive as `critical`.

---

## Field 1 — Claim type

| Type | Means | Resolves by |
|---|---|---|
| **Defect** | This is wrong | Running the check |
| **Risk** | Fails under condition X, unevaluable from the artifact | Deciding whether to hedge |
| **Gap** | Unspecified or unhandled | Back to author |
| **Preference** | Not claiming correctness | Defer |

## Field 2 — Confidence

`certain` · `likely` · `suspicion`

Explicitly cost-free. `suspicion` is wanted, not weak — on weak-verifier components it's often the only signal before production.

## Field 3 — Falsifier (required)

**What evidence would settle this?**

Turns the executor's judgment call into a check. Makes vague objections unfileable. Resolves disagreement to "run it and see" instead of two models asserting at each other.

No falsifier means it's a preference or it's noise. Label it as one.

---

## Routing

Falsifier is the router; type and confidence are descriptive.

- **Falsifiable** → check it, whatever the confidence. A suspicion costs one test run.
- **Not falsifiable, real consequence** → escalate to author. This is the contentious set.
- **Not falsifiable, no consequence** → defer.

Consequence/priority is the executor's field, not the reviewer's. Reviewers describe; prioritizing needs build context they don't have.

---

## Example

```yaml
- type: risk
  confidence: suspicion
  claim: "ping deadline may be shorter than legitimate LTE latency spikes"
  falsifier: "LTE-edge fixture, 400ms RTT + 8s stall; check false-positive reconnects"
  component: liveness-detection
```

Under a severity scale this gets labeled minor and ignored, or never filed.

---

## Metrics

Speculative items **should** be denied often — that's the category working. 90% denial on `suspicion` is healthy; 90% on `certain`+`defect` means the reviewer is broken.

**Read denial rate per type × confidence, or not at all.** Otherwise reviewers learn that raising suspicions hurts their numbers and stop.

Also track:
- Denial rate on `defect` alone
- Share of findings with no falsifier
- Things Fable's code review catches that design review missed on the same component — the tell for reviewers playing it safe