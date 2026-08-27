# 入口 / 节点。Linux 宿主机请用 network_mode: host。
# 构建阶段按 BUILDPLATFORM 交叉编译，不需要 QEMU 跑 Go。

FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS build
WORKDIR /src
ARG TARGETOS
ARG TARGETARCH
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
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
