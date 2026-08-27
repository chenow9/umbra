# 入口 / 节点。Linux 宿主机请用 network_mode: host。
# 先编控制台静态文件，再交叉编译进 umbrad（go:embed）。

FROM --platform=$BUILDPLATFORM node:22-bookworm AS ui
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:embed-ui

FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS build
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
    go build -trimpath -ldflags="-s -w" -o /out/umbra-agent ./cmd/umbra-agent

FROM debian:bookworm-slim AS umbrad
COPY --from=build /out/umbrad /usr/local/bin/umbrad
ENTRYPOINT ["/usr/local/bin/umbrad"]

FROM debian:bookworm-slim AS umbra-agent
COPY --from=build /out/umbra-agent /usr/local/bin/umbra-agent
ENTRYPOINT ["/usr/local/bin/umbra-agent"]
