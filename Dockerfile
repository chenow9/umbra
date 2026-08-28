# 入口 / 节点。Linux 宿主机请用 network_mode: host。
# 基础镜像按 digest 钉死，避免浮动 tag 把未打补丁的工具链打进发布物。
# 更新时同时改 digest 与下面的版本注释。
#
# node 22-bookworm @ 2026-08-25
# golang 1.25.14-bookworm @ 2026-08-19（覆盖审计所列 stdlib CVE 修复线 1.25.13）
# debian bookworm-slim @ 2026-08-25

FROM --platform=$BUILDPLATFORM node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:embed-ui

FROM --platform=$BUILDPLATFORM golang:1.25.14-bookworm@sha256:3b4a11519ad929d1e1d261a12cff056f0c85b735253d7d861346b9c6f8b36437 AS build
WORKDIR /src
ARG TARGETOS
ARG TARGETARCH
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=ui /src/internal/control/ui ./internal/control/ui
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/umbrad ./cmd/umbrad \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/umbra-node ./cmd/umbra-node \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/umbra-visit ./cmd/umbra-visit

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS umbrad
COPY --from=build /out/umbrad /usr/local/bin/umbrad
COPY --from=build /out/umbra-visit /usr/local/bin/umbra-visit
ENTRYPOINT ["/usr/local/bin/umbrad"]

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS umbra-node
COPY --from=build /out/umbra-node /usr/local/bin/umbra-node
ENTRYPOINT ["/usr/local/bin/umbra-node"]
