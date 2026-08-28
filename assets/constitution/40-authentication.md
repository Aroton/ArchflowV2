---
id: human-approval-for-access-control
version: 1
status: active
review_trigger: The change adds or alters authentication, authorization, session or token validation, or permission-decision logic, or changes who may invoke a protected operation.
---
Access-control behavior is security-critical because a defect grants access silently. Work that adds or changes authentication, authorization, or permission-decision logic must be judged against the reviewed repository snapshot before it advances; a result complies when its changed access-control logic does exactly what its approved governing documents require and denies by default where those documents are silent.
