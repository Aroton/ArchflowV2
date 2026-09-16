---
id: approved-design-before-code
version: 3
status: active
---
Implementation starts only from a phase design that either passed its triggered human gate or advanced by rule after counter-review completed; the workflow server withholds the implementation window until then. The PRD, architecture design, and phase design stay truthful as work proceeds: a result that departs from its own phase design updates that phase design in the same reviewed result, and a result that departs from the architecture design or PRD updates those documents in the same result, where the project's approval rules decide whether a human approves the change. A departure from an approved upstream document is reported as a drift finding against that document, not as a failure of this rule.
