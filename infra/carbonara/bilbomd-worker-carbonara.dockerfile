# Carbonara layer for the combined k8s worker image (Phase 2 / "9a" bake-in).
#
# Layers the Carbonara runtime (Carbonara C++ engine + a py3.12 conda env with
# pyFoXS/biobox/torch + an isolated py3.10 cg2all env) ON TOP of the BilboMD worker
# image, so the worker can run Carbonara IN-PROCESS (CARBONARA_EXEC=inprocess) in
# its own k8s pod — no nested container. Mirrors the proven
# Dockerfile.carbonara-allatom-runtime steps, but installs into /opt/conda WITHOUT
# reordering the global PATH, so the worker's own Python (/opt/envs/openmm) and the
# automd-saxs CLI are never shadowed. Carbonara is invoked via a wrapper that
# activates its env (see /usr/local/bin/carbonara-python + convert_cg2all_carbonara).
#
# Build CHAIN (see docs/k8s/K8S_DEPLOYMENT_RUNBOOK.md §4.1):
#   1. bilbomd-worker.dockerfile           -> localhost/bilbomd-worker-branch:<tag>
#   2. infra/automd-saxs/Dockerfile        -> +automd_saxs  (BASE_IMAGE=step 1)
#   3. THIS file                           -> +carbonara    (BASE_IMAGE=step 2)  = the deploy worker image
#
# Build CONTEXT must contain (like the standalone image; see infra/carbonara/README.md):
#   Carbonara/                              a checkout of the upstream Carbonara source
#   carbonara_bilbomd_runner_refined.py     the BilboMD wrapper(s) (source of truth)
#   carbonara_initfoxs.py carbonara_autoflex.py carbonara_results.py
ARG BASE_IMAGE=localhost/bilbomd-worker-combined:v0.1.1
FROM ${BASE_IMAGE}

USER root

# Build/runtime deps for the Carbonara C++ engine, pyFoXS, cg2all pip builds.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git bash ca-certificates libgomp1 file wget bzip2 \
    && rm -rf /var/lib/apt/lists/*

# Standalone micromamba binary (the worker base has conda, but we reproduce the
# carbonara env steps verbatim to minimise risk). Its root prefix is /opt/conda,
# fully separate from the worker's /opt/envs/{base,openmm}.
ENV MAMBA_ROOT_PREFIX=/opt/conda
RUN mkdir -p /opt/conda && \
    wget -qO /tmp/mm.tar.bz2 "https://micro.mamba.pm/api/micromamba/linux-64/latest" && \
    tar -xjf /tmp/mm.tar.bz2 -C /usr/local bin/micromamba && rm -f /tmp/mm.tar.bz2 && \
    /usr/local/bin/micromamba --version

# Carbonara base env (py3.12) in /opt/conda's base prefix.
RUN /usr/local/bin/micromamba install -y -n base -c conda-forge python=3.12 pip \
    && /usr/local/bin/micromamba clean -a -y

# Carbonara source + BilboMD wrapper scripts (wrappers are the source of truth).
COPY Carbonara /opt/carbonara
COPY carbonara_bilbomd_runner_refined.py /opt/carbonara/carbonara_bilbomd_runner_refined.py
COPY carbonara_initfoxs.py /opt/carbonara/carbonara_initfoxs.py
COPY carbonara_autoflex.py /opt/carbonara/carbonara_autoflex.py
COPY carbonara_results.py /opt/carbonara/carbonara_results.py

WORKDIR /opt/carbonara

# Install the Carbonara Python stack + build the C++ engine. Prepend /opt/conda/bin
# to PATH FOR THESE RUN COMMANDS ONLY (via env in the RUN), so the build matches the
# standalone image but the final image PATH is left untouched.
RUN export PATH=/opt/conda/bin:$PATH && \
    PYTHON=/opt/conda/bin/python PIP_INSTALL_OPTS="--no-cache-dir --no-compile" \
    bash /opt/carbonara/setupPython.sh
RUN export PATH=/opt/conda/bin:$PATH && \
    rm -rf build && mkdir build && cd build && cmake .. && make -j2

# Isolated cg2all env (py3.10), identical to the standalone image.
ENV CG2ALL_ENV=/opt/conda/envs/cg2all
RUN /usr/local/bin/micromamba create -y -c conda-forge -p "${CG2ALL_ENV}" python=3.10 pip \
    && /usr/local/bin/micromamba clean -a -y
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" python -m pip install --upgrade pip setuptools wheel
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir "numpy==1.26.4"
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir "torch==1.13.1"
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir "dgl==0.9.1" -f https://data.dgl.ai/wheels/repo.html
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir "e3nn==0.4.4" "ml-collections==0.1.1"
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir git+https://github.com/huhlim/mdtraj.git
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir git+https://github.com/huhlim/SE3Transformer.git
RUN /usr/local/bin/micromamba run -p "${CG2ALL_ENV}" pip install --no-cache-dir --no-deps \
    git+https://github.com/huhlim/cg2all@a00b8816736c08852944f147e39164d0f5e1834e

# Runtime wrappers that ACTIVATE the carbonara envs (so bare `python`/`pyfoxs`
# inside Carbonara resolve to its env, without touching the worker's PATH):
#   carbonara-python              -> the Carbonara py3.12 env python  (CARBONARA_PYTHON_BIN)
#   convert_cg2all_carbonara      -> the cg2all py3.10 env            (CARBONARA_CG2ALL_EXEC)
RUN printf '%s\n' '#!/usr/bin/env bash' \
      'exec /usr/local/bin/micromamba run -p /opt/conda python "$@"' \
      > /usr/local/bin/carbonara-python && chmod +x /usr/local/bin/carbonara-python
RUN printf '%s\n' '#!/usr/bin/env bash' \
      'exec /usr/local/bin/micromamba run -p /opt/conda/envs/cg2all convert_cg2all "$@"' \
      > /usr/local/bin/convert_cg2all_carbonara && chmod +x /usr/local/bin/convert_cg2all_carbonara

# Point the worker's Carbonara config at the baked-in tools (also settable via the
# k8s ConfigMap; these ENV defaults make the image work without extra wiring).
ENV CARBONARA_PYTHON_BIN=/usr/local/bin/carbonara-python \
    CARBONARA_ROOT=/opt/carbonara \
    CARBONARA_RUNNER=/opt/carbonara/carbonara_bilbomd_runner_refined.py \
    CARBONARA_INITFOXS_PATH=/opt/carbonara/carbonara_initfoxs.py \
    CARBONARA_AUTOFLEX_PATH=/opt/carbonara/carbonara_autoflex.py \
    CARBONARA_RESULTS_PATH=/opt/carbonara/carbonara_results.py \
    CARBONARA_DATATOOLS_PATH=/opt/carbonara/CarbonaraDataTools.py \
    CARBONARA_CG2ALL_EXEC=/usr/local/bin/convert_cg2all_carbonara \
    CARBONARA_MULTIFOXS_BIN=/usr/bin/multi_foxs

# Smoke checks: the Carbonara toolchain works, AND the worker's own tools are intact.
RUN carbonara-python -c "import CarbonaraDataTools, biobox, torch; print('carbonara py OK')" \
    && /usr/local/bin/micromamba run -p /opt/conda pyfoxs --help >/dev/null && echo "pyfoxs OK" \
    && convert_cg2all_carbonara --help >/dev/null && echo "cg2all OK" \
    && test -x /opt/carbonara/build/* 2>/dev/null; ls /opt/carbonara/build | head -3 \
    && /opt/envs/openmm/bin/automd-saxs --help >/dev/null && echo "automd-saxs still OK" \
    && /usr/bin/multi_foxs --help >/dev/null 2>&1 || true

WORKDIR /app
