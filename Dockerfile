# 入口。Linux 宿主机请用 network_mode: host。
FROM debian:bookworm-slim
COPY dist/umbrad_linux_amd64 /usr/local/bin/umbrad
COPY dist/umbra-agent_linux_amd64 /usr/local/bin/umbra-agent
ENTRYPOINT ["/usr/local/bin/umbrad"]
