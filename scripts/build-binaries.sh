#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export PATH="/usr/local/go/bin:${PATH}"
mkdir -p dist
build() {
  goos=$1
  goarch=$2
  ext=""
  if [ "$goos" = "windows" ]; then ext=".exe"; fi
  echo "build $goos/$goarch"
  GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "dist/umbrad_${goos}_${goarch}${ext}" ./cmd/umbrad
  GOOS=$goos GOARCH=$goarch CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o "dist/umbra-agent_${goos}_${goarch}${ext}" ./cmd/umbra-agent
}
build linux amd64
build linux arm64
build darwin amd64
build darwin arm64
build windows amd64
build windows arm64
install -m 755 dist/umbrad_linux_amd64 /usr/local/bin/umbrad
install -m 755 dist/umbra-agent_linux_amd64 /usr/local/bin/umbra-agent
ls -l dist
