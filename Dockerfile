# syntax=docker/dockerfile:1.7
# Сборка: Rust (API + WASM-ядро) → SvelteKit (статический сайт) → два финальных образа.

FROM rust:1.99.0-slim-trixie AS rust
WORKDIR /src
RUN cargo install wasm-bindgen-cli --version 0.2.129 --locked
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
RUN rustup show
COPY crates crates
COPY fixtures fixtures
# Паритет ядра с прежней реализацией проверяется при каждой сборке образа.
RUN cargo test --release -p scoring-core \
 && cargo build --release -p api \
 && cargo build --release -p scoring-wasm --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /wasm --out-name scoring target/wasm32-unknown-unknown/release/scoring_wasm.wasm

FROM node:26.11.1-trixie-slim AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
COPY fixtures /src/fixtures
COPY contracts /src/contracts
COPY --from=rust /wasm ./src/lib/wasm
# Тот же набор эталонов проверяется и в WASM-сборке.
RUN npx svelte-kit sync && npx vitest run && npx vite build

FROM debian:trixie-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app perepev \
 && mkdir -p /data && chown perepev:perepev /data
WORKDIR /app
COPY --from=rust /src/target/release/perepev-api /app/perepev-api
COPY web/static/songs /app/songs
USER perepev
# /data — том с приватными файлами; новый том Docker создаёт с владельцем uid 10001.
ENV BIND=0.0.0.0:3001 SONGS_DIR=/app/songs DATA_DIR=/data TRUST_PROXY=true RUST_LOG=info
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD ["/app/perepev-api", "healthcheck"]
ENTRYPOINT ["/app/perepev-api"]
CMD ["serve"]

FROM caddy:2.11.7-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /src/web/build /srv
