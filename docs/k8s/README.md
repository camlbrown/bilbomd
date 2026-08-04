# Kubernetes deployment docs (Diamond)

Deployment of BilboMD + the Carbonara and AutoMD-SAXS workers to the Diamond Light
Source Kubernetes cluster. Read in this order:

1. **[K8S_READINESS_AUDIT.md](./K8S_READINESS_AUDIT.md)** — architecture, branch
   relationships, Carbonara divergence, Helm support, gaps, and (see §1a) the
   implementation status of everything done so far.
2. **[K8S_PHASE2_PREP_PLAN.md](./K8S_PHASE2_PREP_PLAN.md)** — ordered prep tasks
   (must / should / can-after), each with why · files · verify · reversibility.
3. **[K8S_GIT_INTEGRATION_PROCEDURE.md](./K8S_GIT_INTEGRATION_PROCEDURE.md)** — the
   exact, reversible Git steps that produced this deployment branch.
4. **[K8S_DEPLOYMENT_RUNBOOK.md](./K8S_DEPLOYMENT_RUNBOOK.md)** — practical,
   placeholder-driven build/deploy/verify/rollback commands for the meeting.
5. **[K8S_MEETING_CHECKLIST.md](./K8S_MEETING_CHECKLIST.md)** — questions/values to
   get from the cluster admin + a minimal success definition.

Deployment branch: `integration/k8s-carbonara-automdsaxs`. Helm chart: `infra/helm/`
(Diamond values: `infra/helm/values-diamond.yaml`). Background planning notes
(`K8S_DEPLOYMENT_PLAN.md`, `ROUTE_TO_K8S.md`) live in the AutoMD-SAXS repo.
