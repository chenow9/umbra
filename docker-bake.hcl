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

target "umbra-agent" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "umbra-agent"
  platforms  = ["linux/amd64", "linux/arm64"]
  tags = [
    "${REGISTRY}/umbra-agent:${TAG}",
  ]
}

group "default" {
  targets = ["umbrad", "umbra-agent"]
}
