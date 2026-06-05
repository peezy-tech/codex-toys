FROM node:24-bookworm-slim

ARG CODEX_TOYS_VERSION=latest
ARG CODEX_VERSION=latest
ARG DEBIAN_FRONTEND=noninteractive

LABEL org.opencontainers.image.title="codex-toys Actions runner"
LABEL org.opencontainers.image.description="Base image for codex-toys Actions-mode workbench runs."
LABEL org.opencontainers.image.source="https://github.com/peezy-tech/codex-toys"
LABEL org.opencontainers.image.licenses="Apache-2.0"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash \
		ca-certificates \
		curl \
		git \
		jq \
		openssh-client \
		ripgrep \
		tar \
		unzip \
		xz-utils \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@^11.10.0 pnpm@11.1.3 vite-plus \
	&& for attempt in 1 2 3 4 5 6; do \
		npm install -g "codex-toys@${CODEX_TOYS_VERSION}" && break; \
		if [ "${attempt}" = 6 ]; then exit 1; fi; \
		sleep 10; \
	done \
	&& codex-toys --help >/dev/null

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
	&& codex --version

ENV CODEX_NON_INTERACTIVE=1
WORKDIR /workspace

CMD ["codex-toys", "--help"]
