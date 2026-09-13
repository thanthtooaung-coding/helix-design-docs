---
title: "43. Appendix A — Open questions to settle before Phase 2"
description: "Decisions to settle before phase 2."
sidebar:
  order: 43
---

1. **Pricing model.** Instance-second billing versus request-based changes the autoscaler's tuning targets and whether cold-start time is billable. Decide before metering is built.
2. **Free tier shape.** Its generosity determines your abuse exposure more than any technical control.
3. **arm64 from the start?** Cheaper and increasingly well-supported, but doubles the build matrix and the runtime-image inventory. Leaning yes for <span class="mat mat-v1">V1</span>.
4. **Persistent volumes: ever?** Saying "no, use object storage and managed databases" is defensible and saves enormous complexity. Decide explicitly rather than drifting.
5. **Self-hosted / on-prem edition?** Changes packaging, licensing, and the coupling between control plane and infrastructure assumptions. Cheap to keep possible now, expensive to retrofit.
6. **Managed database add-ons?** High customer demand, entirely different operational discipline (stateful, backup, upgrade). Probably a partnership rather than a build.
7. **Region list and data residency commitments.** Drives infrastructure spend and compliance scope.
8. **Open-source strategy.** Runtime definitions are a natural open-source surface with real community leverage; the control plane is not.
