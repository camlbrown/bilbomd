# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## What is BilboMD?

BilboMD is a SAXS (Small Angle X-ray Scattering) modelling platform that uses
molecular dynamics (CHARMM/OpenMM) to generate molecular models, calculates
theoretical SAXS curves via FoXS, and finds best-fit ensembles via MultiFoXS.
It supports 7 existing job types: `pdb`, `crd`, `auto`, `alphafold`, `sans`,
`scoper`, `multi`.

This development branch is being used to add an additional local Carbonara
worker pathway. Carbonara should be integrated conservatively by following
existing BilboMD worker, backend, schema, and UI patterns rather than rewriting
unrelated code.

## Current Local Development Context

Development is currently local to the DLS workstation. Do not assume that work
should be pushed, deployed, merged, or opened as a pull request unless explicitly
instructed.

### Key local paths

```bash
# BilboMD local clone
/home/kri42825/bilbomd

# Carbonara source/check-out used for integration reference
/home/kri42825/carbonara-pseudoWaxsis
```

Related local paths from the Carbonara preparation work may include container,
environment, and scratch locations. Only use these if the user has explicitly
asked for container-level testing or provided the relevant command context.

```bash
/home/kri42825/carbonara-container-dev
/scratch/kri42825/carbonara_envs/carbonara-dls-py3122
/scratch/kri42825/podman
/scratch/kri42825/tmp
```

### Expected Git remotes

The BilboMD repository is owned by another maintainer. The expected local remote
layout is:

```bash
origin    https://github.com/camlbrown/bilbomd.git
upstream  https://github.com/bl1231/bilbomd.git
```

- `origin` is the user's fork.
- `upstream` is the original BilboMD repository.
- Pull/fetch updates from `upstream`.
- Push only to `origin`, and only when explicitly instructed.
- The `upstream` push URL should preferably be disabled locally to avoid
  accidental pushes:

```bash
git remote set-url --push upstream DISABLED
```

### Current working branch

The expected working branch for this integration is:

```bash
feature/carbonara-worker
```

Do not work directly on `main`. Do not create additional branches unless the
user explicitly asks for that.

### Local files that must not be committed

The following files are local DLS/Podman helper files. They may be useful for the
user's machine, but they should not be committed to the BilboMD repository or
included in a future pull request unless the user explicitly says otherwise.

```bash
infra/begin_bilbo
infra/docker-compose.local.podman.gpu.yml
infra/docker-compose.local.podman.yml
infra/old_useful_commands.txt
infra/shortcuts.txt
infra/worker.env
```

Prefer adding these to `.git/info/exclude` rather than `.gitignore`, because the
ignore rule should remain local to this workstation:

```bash
cat >> .git/info/exclude <<'EOF_LOCAL_EXCLUDE'

# Local DLS/Podman development files; do not commit
infra/begin_bilbo
infra/docker-compose.local.podman.gpu.yml
infra/docker-compose.local.podman.yml
infra/old_useful_commands.txt
infra/shortcuts.txt
infra/worker.env
EOF_LOCAL_EXCLUDE
```

## Claude Code Rules for This Carbonara Phase

These rules override any more general development workflow advice below.

- Work locally only.
- Do not push to GitHub unless explicitly instructed.
- Do not open pull requests unless explicitly instructed.
- Do not merge branches unless explicitly instructed.
- Do not commit unless explicitly instructed.
- Do not work directly on `main`.
- Do not alter unrelated BilboMD workers, pipelines, deployment files, or UI
  flows unless the change is absolutely required to register, run, display, or
  test the Carbonara worker.
- Before editing files, inspect the relevant existing BilboMD patterns and
  report the minimal set of files that need to change.
- Prefer small, reviewable changes over broad rewrites.
- Keep Carbonara integration isolated behind a clear worker/backend/schema/UI
  contract.
- Do not replace existing `pdb`, `crd`, `auto`, `alphafold`, `sans`, `scoper`,
  or `multi` behaviour.
- If a shared type, schema, route, or UI component must be changed, explain why
  it is required for Carbonara and confirm that unrelated workflows remain
  compatible.
- After each meaningful change, report:
  - files changed;
  - why they were changed;
  - how to test them;
  - whether any unrelated pipeline was touched.

### Recommended first Claude Code instruction

When starting this work, the user is likely to begin Claude Code from:

```bash
cd /home/kri42825/bilbomd
git status
claude
```

A suitable first instruction is:

```text
Read CLAUDE.md (/home/kri42825/bilbomd/CLAUDE.md) and the Carbonara CLAUDE.md (/home/kri42825/carbonara-pseudoWaxsis/CLAUDE.md). We are on branch feature/carbonara-worker.

Development rules:
- Work locally only.
- Do not push to GitHub.
- Do not open pull requests.
- Do not merge branches.
- Do not commit unless explicitly instructed.
- Do not modify unrelated BilboMD workers or pipelines.
- Do not alter main directly.
- Before editing, inspect the existing BilboMD worker architecture and propose
  the minimal files that need to change for a Carbonara worker.
```

For the first architecture inspection, use the most capable available model if
the user selects one. For iterative implementation and lint/build fixes, a
faster model is acceptable once the architecture is agreed.

## Carbonara Integration Intent

Carbonara has already been prepared outside BilboMD so that it can be run more
easily from a worker-style interface. The current validated direction is:

1. Use the existing local Carbonara wrapper/container work as the execution
   boundary.
2. Add a BilboMD worker pathway that can submit a Carbonara job, monitor it,
   collect outputs, and update job status in the same style as existing workers.
3. Begin with a minimal local test run rather than a full UI-driven feature set.
4. Add UI controls later based on the functionality currently exposed through
   Carbonara notebooks.

The all-atom route should use the `cg2all-carbonara` path. Do not design or add
a MODELLER-based pathway unless the user explicitly changes the project scope.
The Carbonara container is expected to include the required cg2all tooling based
on previous validation.

## Monorepo Structure

Turborepo + pnpm workspaces. Node v24.13.0 (see `.nvmrc`).

**Apps:**

- `apps/backend` (`@bilbomd/backend`) — Express.js REST API with MongoDB + Redis, JWT auth, BullMQ job queue
- `apps/ui` (`@bilbomd/ui`) — React SPA with RTK Query, Material-UI, Formik, Recharts, Molstar
- `apps/worker` (`@bilbomd/worker`) — Node.js BullMQ job processor running MD simulations, supports both local (Hyperion) and NERSC/Perlmutter (Slurm) execution
- `apps/scoper` (`@bilbomd/scoper`) — Specialized worker for Mg2+ ion prediction in RNA

**Packages:**

- `packages/bilbomd-types` (`@bilbomd/bilbomd-types`) — Shared TypeScript type definitions
- `packages/mongodb-schema` (`@bilbomd/mongodb-schema`) — Mongoose schemas with dual exports: `@bilbomd/mongodb-schema` (full, for backend/worker) and `@bilbomd/mongodb-schema/frontend` (frontend-safe subset)
- `packages/md-utils` (`@bilbomd/md-utils`) — Molecular dynamics constraint utilities
- `packages/eslint-config` (`@bilbomd/eslint-config`) — Shared ESLint config

## Build & Dev Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build everything (turbo, respects dependency order)
pnpm dev              # Start all services in dev mode (parallel)
pnpm lint             # Lint all packages
pnpm test             # Run all tests
pnpm format           # Format with prettier
pnpm format:check     # Check formatting
```

### Per-package commands

```bash
# Filter to a specific package
pnpm -F @bilbomd/backend run dev
pnpm -F @bilbomd/ui run dev
pnpm test --filter @bilbomd/backend
pnpm test --filter @bilbomd/ui

# Backend-specific
pnpm -F @bilbomd/backend run test:watch
pnpm -F @bilbomd/backend run test:integration

# UI-specific
pnpm -F @bilbomd/ui run test:watch
pnpm -F @bilbomd/ui run test:ui          # Vitest UI
```

### Docker / Podman local dev

The upstream docs may refer to Docker. On the current DLS workstation, local
BilboMD testing has used Podman and local compose overlays. Do not assume Docker
Desktop or rootful Docker is available.

Default upstream local commands:

```bash
cd infra
./build.sh local     # Build local Docker images
./run.sh local       # Start all services via docker-compose.local.yml
```

For this DLS local setup, inspect existing local notes and user instructions
before changing compose files. Do not commit local Podman helper files unless the
user explicitly asks.

Environment: copy `infra/.env.example` to `infra/.env.local` when needed. Do not
commit local environment files or secrets.

## Testing

- Framework: **Vitest** for all packages. React Testing Library for UI components.
- Place test files in `__tests__` directories within each module, not at project root.
  - Example: `src/controllers/jobs/__tests__/getAllJobs.test.ts`
- Do not use `--reporter=verbose` flag.
- Use `vi` from vitest for mocking, not jest globals.

For Carbonara integration, start with the narrowest relevant checks, then expand
only as needed:

```bash
pnpm -F @bilbomd/worker lint
pnpm -F @bilbomd/worker build
pnpm -F @bilbomd/worker test

pnpm -F @bilbomd/backend lint
pnpm -F @bilbomd/backend build
pnpm -F @bilbomd/backend test
```

If shared packages or UI files are touched, also run the relevant filtered checks
for those packages.

## Code Style

- **Prettier** config: no semicolons, single quotes, no trailing commas, 80-char width, `singleAttributePerLine: true`
- Prefer **arrow functions**: `const myFunc = () => {}`
- Avoid `any`; use proper types or generics
- Prefer functional patterns over classes
- All modules use ESM (`"type": "module"`)
- TypeScript target: ES2022, module: NodeNext

## Development Workflow

### Local Carbonara workflow

For the current Carbonara worker work, use this workflow:

1. Confirm the branch and worktree state.

   ```bash
   cd /home/kri42825/bilbomd
   git status
   git branch --show-current
   git remote -v
   ```

2. Ensure the branch is `feature/carbonara-worker`.

3. Inspect existing patterns before editing. Likely areas include:
   - worker dispatch and pipeline files in `apps/worker`;
   - backend job submission and validation in `apps/backend`;
   - shared types in `packages/bilbomd-types`;
   - MongoDB schemas in `packages/mongodb-schema`;
   - UI job forms and result displays in `apps/ui`, only when the worker/backend
     contract is ready.

4. Make the smallest coherent change.

5. Run relevant filtered checks.

6. Report changed files and test results.

7. Do not commit, push, merge, or open a PR unless explicitly instructed.

### Standard upstream workflow, for later PR preparation

The upstream project uses feature branches, tests, builds, and pull requests. A
future Carbonara pull request should eventually come from the user's fork
(`origin`) back to the original BilboMD repository (`upstream`). This is a later
review step, not permission for Claude Code to publish changes now.

Before a future PR, ensure all relevant checks pass:

```bash
# 1. Linting
pnpm lint

# 2. Build
pnpm build

# 3. Tests
pnpm test
```

For package-specific work, run the checks filtered to that package:

```bash
# Example for UI package
pnpm -F @bilbomd/ui lint
pnpm -F @bilbomd/ui build
pnpm -F @bilbomd/ui test

# Example for backend package
pnpm -F @bilbomd/backend lint
pnpm -F @bilbomd/backend build
pnpm -F @bilbomd/backend test

# Example for worker package
pnpm -F @bilbomd/worker lint
pnpm -F @bilbomd/worker build
pnpm -F @bilbomd/worker test
```

If any checks fail:

- Fix linting errors before considering the work ready.
- Resolve TypeScript/build errors.
- Fix failing tests or update tests only when behaviour changed intentionally.
- Do not push code that fails relevant checks.

### Manual commit/push guidance, only when explicitly instructed

If the user explicitly asks for a commit:

```bash
git status
git diff
git add -A
git commit -m "descriptive commit message"
```

If the user explicitly asks to push the branch to the fork:

```bash
git push origin feature/carbonara-worker
```

Do not push to `upstream`.

## Versioning

Uses **Changesets** for per-package versioning. After code changes, a changeset
may be required before a future PR. Do not create one unless the user asks or the
project maintainer requires it.

```bash
pnpm changeset        # Select packages, choose semver bump, write summary
```

Changesets are applied on merge to `main`, producing git tags and Docker image
semver tags. `updateInternalDependencies: "patch"` is enabled; bumping an
internal package auto-bumps dependents.

### Manual Changeset Creation

**IMPORTANT**: The `pnpm changeset` command is interactive and may not work in
non-TTY environments, including some Claude Code CLI contexts. When this happens,
create changeset files manually only if a changeset is actually needed.

1. **Create a new file** in `.changeset/` with a descriptive kebab-case name:
   - Pattern: `.changeset/descriptive-name.md`
   - Examples: `worker-code-quality-improvements.md`, `backend-security-fixes.md`

2. **File format** with YAML front matter and description:

   ```markdown
   ---
   '@bilbomd/package-name': patch|minor|major
   ---

   Brief description of changes. Focus on user/developer impact, not implementation details.
   ```

3. **Semver guidelines**:
   - `patch` - Bug fixes, minor improvements, internal refactoring
   - `minor` - New features, significant improvements, backwards compatible
   - `major` - Breaking changes

4. **Examples**:

   ```markdown
   ---
   '@bilbomd/worker': patch
   ---

   Improve worker reliability with graceful shutdown handling and MongoDB connection retry logic.
   ```

   ```markdown
   ---
   '@bilbomd/worker': minor
   ---

   Add Carbonara worker support for local container-backed SAXS-guided modelling jobs.
   ```

5. **Multiple packages**, if changes affect multiple:

   ```markdown
   ---
   '@bilbomd/backend': patch
   '@bilbomd/mongodb-schema': patch
   ---

   Add shared job validation and schema support for Carbonara jobs.
   ```

## Git Branch Naming Convention

Use standardized branch prefixes to indicate the type of work. Branch names
should use kebab-case, lowercase with hyphens.

### Core Prefixes

- `feature/` — New features and enhancements
  - Examples: `feature/user-auth`, `feature/saxs-export`, `feature/backend/new-api`
- `fix/` — Bug fixes
  - Examples: `fix/login-redirect`, `fix/job-timeout`, `fix/ui-chart-rendering`
- `refactor/` — Code refactoring without functional changes
  - Examples: `refactor/clean-old-code`, `refactor/backend-simplify-middleware`
- `docs/` — Documentation-only changes
  - Examples: `docs/update-readme`, `docs/api-guide`, `docs/add-deployment-notes`

### Additional Prefixes

- `test/` — Adding or updating tests
  - Examples: `test/add-middleware-tests`, `test/ui-job-form-validation`
- `chore/` — Maintenance tasks, dependency updates, build changes
  - Examples: `chore/update-deps`, `chore/configure-prettier`
- `perf/` — Performance improvements
  - Examples: `perf/optimize-query`, `perf/worker-reduce-memory-usage`
- `ci/` — CI/CD pipeline changes
  - Examples: `ci/add-coverage-report`, `ci/fix-build-cache`

### Naming Guidelines

1. **Format**: Use kebab-case for the descriptive part.
   - Good: `feature/add-user-roles`
   - Bad: `feature/Add_User_Roles`, `feature/addUserRoles`

2. **Scope**: Include package scope when it adds clarity in the monorepo.
   - With scope: `feature/backend-job-queue-retry`
   - Without scope: `feature/job-queue-retry`
   - Common scopes: `backend`, `ui`, `worker`, `scoper`

3. **Description**: Keep it concise but descriptive.
   - Good: `fix/job-status-update`
   - Too vague: `fix/bug`
   - Too verbose: `fix/issue-with-job-status-not-updating-correctly-in-database`

4. **Issue tracking**: Include issue numbers when applicable.
   - Example: `fix/job-timeout-issue-123` or `feature/add-export-399`

## Architecture Details

### Job Processing Flow

1. Frontend submits job via RTK Query to backend `/jobs` endpoint.
2. Backend stores job in MongoDB and enqueues it to Redis/BullMQ.
3. Worker picks up job from the queue and runs the appropriate pipeline.
4. Worker updates job status/progress in MongoDB during execution.
5. Results are prepared and made available for download/display.

### Carbonara Worker Integration Shape

The Carbonara worker should follow the existing BilboMD job-processing style as
closely as possible:

1. Backend validates and stores a Carbonara job request.
2. Backend enqueues the job with enough metadata for the worker to find inputs
   and write outputs.
3. Worker creates or receives a job working directory.
4. Worker calls the Carbonara wrapper/container execution boundary rather than
   reimplementing Carbonara scientific logic in TypeScript.
5. Worker captures stdout/stderr/logs and maps them to BilboMD progress/status
   conventions.
6. Worker collects known result files into the expected BilboMD results layout.
7. UI support should initially be minimal and should only expand after the
   worker/backend contract has been validated locally.

### Carbonara scope boundaries

For this branch:

- The first target is a local Carbonara job path, not NERSC deployment.
- The first target should be a simple validated run, not the full notebook UI.
- All-atom support should use the `cg2all-carbonara` route.
- Do not introduce MODELLER as a dependency or route unless explicitly asked.
- Do not modify unrelated MD/OpenMM/FoXS/MultiFoXS/SANS/Scoper logic unless a
  shared registration point truly requires it.

### NERSC/Perlmutter Integration

The worker has a separate NERSC code path (`bilbomd-nersc.ts`,
`bilboMdNerscJobMonitor.ts`) that submits Slurm jobs to Perlmutter for
GPU-accelerated simulations. NERSC API token management is in
`nersc-api-token-functions.ts`.

Do not modify the NERSC code path for the initial local Carbonara worker unless
the user explicitly asks or an existing shared type requires a minimal update.

### MongoDB Data Model

- Jobs stored with **embedded user objects**; filter with `{'user._id': user._id}`, not `{user: user._id}`.
- Collections: `users` with roles Admin/Manager/User, `jobs`, `multijobs`.
- `buildBilboMDJobDTO()` transforms MongoDB documents to frontend DTOs.

### Frontend State Management

- RTK Query for server state with polling.
- Redux Toolkit Entity Adapters for normalized job state.
- Role-based access: Admin/Manager see all jobs, users see own.

For Carbonara, do not design the full UI until the backend/worker execution
contract is validated. Later UI design should be informed by the Carbonara
notebook cells and their user-facing functionality.

### Deployments

- **Hyperion** (SIBYLS beamline): `infra/docker-compose-hyperion.yml` — CPU workflows (Classic, Auto, Multi, SANS, Scoper)
- **NERSC**: Docker Compose / Helm — GPU workflows (Classic, Auto, AF/AlphaFold)

Initial Carbonara development is local only and should not change deployment
configuration unless explicitly requested.
