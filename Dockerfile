FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/

ARG SOURCE_COMMIT
ARG SOURCE_DATE_EPOCH
RUN case "$SOURCE_COMMIT" in \
      (*[!0-9a-f]*|'') echo "SOURCE_COMMIT must be a lowercase 40-character Git SHA" >&2; exit 1;; \
    esac && \
    test "${#SOURCE_COMMIT}" -eq 40 && \
    case "$SOURCE_DATE_EPOCH" in \
      (*[!0-9]*|'') echo "SOURCE_DATE_EPOCH must be an integer" >&2; exit 1;; \
    esac && \
    GITHUB_SHA="$SOURCE_COMMIT" SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" npm run build && \
    npm prune --omit=dev && \
    npm cache clean --force

FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019 AS runtime

ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/OilpriceAPI/mcp-server" \
      org.opencontainers.image.revision="$SOURCE_COMMIT"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=builder --chown=node:node /app/build/ ./build/

USER node
ENTRYPOINT ["node", "build/index.js"]
