---
'@bilbomd/worker': minor
'@bilbomd/backend': minor
'@bilbomd/ui': minor
'@bilbomd/bilbomd-types': minor
'@bilbomd/mongodb-schema': minor
---

Add Carbonara worker support — a local, container-backed SAXS-guided modelling
pathway. Users can submit a Carbonara job (structure + experimental SAXS) via a
new `carbonara` job type and job form. The worker runs coarse-grained Carbonara
fitting in the Carbonara container and, when the all-atom option is enabled,
performs cg2all all-atom reconstruction (with optional FoXS scoring) as a
post-run step, collecting all-atom PDB outputs. Adds the `BilboMdCarbonara`
schema/discriminator and shared DTO. Existing job types (pdb, crd, auto,
alphafold, openfold, sans, scoper, multi) are unaffected.
