# Self-contained AutoMD-SAXS runtime image.
#
# The BilboMD worker image already ships OpenMM (/opt/envs/openmm) and FoXS/
# MultiFoXS (/usr/bin). This layer adds scikit-learn (for CLoNe/PCA clustering)
# and the external `automd-saxs` CLI into that OpenMM env, so the worker can run
# `automd-saxs run --config ... --out ...` against real OpenMM + FoXS.
#
# Build with the AutoMD-SAXS package repo as the build context:
#   podman build -f infra/automd-saxs/Dockerfile \
#     -t localhost/bilbomd-automd-saxs:dev /home/kri42825/AutoMD-SAXS
#
# Pin a tag for reproducible deployment by checking out that tag before building.
ARG BASE_IMAGE=ghcr.io/bl1231/bilbomd-worker:2.10.0
FROM ${BASE_IMAGE}

# AutoMD-SAXS source (the build context is the AutoMD-SAXS repo).
COPY . /opt/automd-saxs

# Install scikit-learn + the automd-saxs CLI into the OpenMM env (which already
# has openmm, pdbfixer, mdtraj, numpy, scipy). --no-deps for automd-saxs: it has
# no runtime deps of its own and we don't want pip to disturb the curated env.
RUN /opt/envs/openmm/bin/pip install --no-cache-dir scikit-learn \
 && /opt/envs/openmm/bin/pip install --no-cache-dir --no-deps /opt/automd-saxs \
 && /opt/envs/openmm/bin/automd-saxs --help >/dev/null

ENV AUTOMD_SAXS_BIN=/opt/envs/openmm/bin/automd-saxs
