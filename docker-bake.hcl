variable "REGISTRY" {
  default = "chenow9"
}

variable "TAG" {
  default = "latest"
}

target "umbrad" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "umbrad"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags = [
    "${REGISTRY}/umbrad:${TAG}",
  ]
}

target "umbra-node" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "umbra-node"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags = [
    "${REGISTRY}/umbra-node:${TAG}",
  ]
}

group "default" {
  targets = ["umbrad", "umbra-node"]
}
