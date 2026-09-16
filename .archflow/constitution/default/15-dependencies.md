---
id: prefer-established-libraries
version: 1
status: active
---
Standard, mature, widely-adopted, and actively-maintained libraries and platform primitives must be preferred over custom or bespoke implementations for common domain problems. Authoring custom machinery for capabilities that have well-established ecosystem solutions complies only when the governing design document explicitly justifies why available libraries are unsuitable (such as incompatible licensing, critical security boundaries, unacceptable runtime footprint, or unresolvable architectural constraints). Selected libraries must demonstrate active maintenance and verifiable community adoption; unmaintained, abandoned, or obscure single-user packages must not be introduced.
