# syntax=docker/dockerfile:1
#
# Build this image from a workspace that has already been built:
#
#   pnpm build && pnpm --filter emulate build:bundle
#   docker build -t <user>/emulate-github:<tag> .
#
# The CLI is bundled into a single self-contained file, so the image needs no
# package installation and builds without registry access.

FROM node:24-slim

# git is a hard runtime requirement, not an optimisation. The Git smart HTTP
# transport spawns `git upload-pack` and `git receive-pack`, and the importer
# shells out to `git clone --mirror`. Without git the emulator would start but
# every clone and push would fail, so verify it at build time and again at
# startup.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --version

# Marks how the image was produced. Preview builds from an unmerged branch
# announce themselves at startup so nobody mistakes one for a release.
ARG EMULATE_BUILD_CHANNEL=local
ARG EMULATE_BUILD_REF=unknown
ENV EMULATE_BUILD_CHANNEL=$EMULATE_BUILD_CHANNEL
ENV EMULATE_BUILD_REF=$EMULATE_BUILD_REF

LABEL org.opencontainers.image.title="emulate GitHub emulator"
LABEL org.opencontainers.image.description="Unofficial preview build of the emulate GitHub emulator with Git transport and GraphQL. Not a release, and not affiliated with the upstream project."
LABEL org.opencontainers.image.source="https://github.com/cedricvidal/emulate"
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL dev.emulate.build.channel=$EMULATE_BUILD_CHANNEL
LABEL dev.emulate.build.ref=$EMULATE_BUILD_REF

WORKDIR /app

COPY packages/emulate/dist-bundle/ ./emulate/
COPY scripts/import-github.mjs ./scripts/import-github.mjs
COPY docker/entrypoint.sh /usr/local/bin/entrypoint

RUN chmod +x /usr/local/bin/entrypoint /app/scripts/import-github.mjs \
  && ln -sf /app/scripts/import-github.mjs /app/scripts/import-github

# Mirrors for the bare repositories backing Git smart HTTP, and the directory an
# import writes to. Mount a volume at /data to reuse a snapshot across runs.
ENV EMULATE_GIT_DIR=/data/git
ENV EMULATE_IMPORT_DIR=/data/import
ENV EMULATE_CLI=/app/emulate/index.js
RUN mkdir -p /data/git /data/import
VOLUME ["/data"]

# gh builds github.localhost URLs with no port, so serving on 80 lets gh and git
# reach the emulator by hostname without a proxy.
ENV EMULATE_PORT=80
EXPOSE 80

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.EMULATE_PORT||80)+'/rate_limit').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD []
