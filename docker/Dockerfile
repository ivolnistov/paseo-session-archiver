# Isolated build/test/daemon image for session-archiver. No host mounts, no credentials.
# NPM_REGISTRY must be your approved package registry; there is deliberately no default.
FROM node:22.18.0-bookworm-slim AS base
ARG NPM_REGISTRY
RUN test -n "$NPM_REGISTRY" || (echo "NPM_REGISTRY build arg is required" >&2; exit 1)
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false CI=1
# WORKDIR creates directories as root; hand them to node before dropping privileges.
RUN mkdir -p /work/session-archiver && chown -R node:node /work
WORKDIR /work/session-archiver
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --ignore-scripts

# typecheck + unit tests (tests/** owned by the test role). Runs with network disabled.
FROM base AS check
COPY --chown=node:node . .
CMD ["sh", "-c", "npm run typecheck && if ls tests/*.test.ts >/dev/null 2>&1; then npm test; else echo 'no tests yet'; fi"]

# Disposable Paseo 0.11.1 daemon for integration and archive/restore readiness.
# PASEO_HOME lives inside the container only. Mock/stub provider configuration is container-private.
FROM base AS daemon
USER root
RUN npm install -g @getpaseo/cli@0.11.1 && paseo --version | grep -q '0.11.1' && mkdir -p /home/node/.paseo && chown node:node /home/node/.paseo
USER node
ENV PASEO_HOME=/home/node/.paseo
COPY --chown=node:node . /work/session-archiver
# Prefetch: warm the npm cache from the explicit registry so the manifest build step, which is
# itself `npm ci --offline`, succeeds at `paseo plugin install` without network.
RUN npm ci --omit=dev --ignore-scripts
CMD ["sleep", "infinity"]
