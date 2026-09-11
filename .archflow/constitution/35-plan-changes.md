---
id: human-approval-for-material-plan-changes
version: 1
status: active
review_trigger: The result changes a governing PRD or architecture document and the authenticated before-and-after comparison shows a material change to human-approved requirements, scope, architecture, externally consumed interfaces, trust boundaries, or verification commitments. Report not-matched for meaning-preserving wording, formatting, and implementation-detail updates. Evaluate the complete change from the last human-approved baseline, not only the last automatic amendment. When the server supplies a changed governing document without an authenticated baseline, or the comparison cannot settle materiality, report uncertain with the missing evidence; never infer approval from the producer's classification.
---
The PRD and architecture remain truthful as implementation proceeds. Independently reviewed maintenance that preserves approved decisions may advance automatically over the newly reviewed bytes. Material changes require a human decision. The server-provided comparison binds the prior human-approved content and proposed document identity; review rationale must describe the changed decisions or why they remain unchanged. SQL, public-contract and other independently matched approval rules still apply, regardless of the amendment's size.
