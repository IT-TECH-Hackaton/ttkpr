#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu server (run as root on the server):
# Docker + compose from Ubuntu's repositories, a firewall with SSH/HTTP/HTTPS only, swap for builds.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io docker-compose-v2 docker-buildx ufw openssl curl ca-certificates
systemctl enable --now docker

# Image builds (pnpm install, vite, OpenCV wheels) peak above 4 GB RAM: add 4 GB of swap once.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Only SSH and the web: Postgres and Redis stay inside the Docker network.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

mkdir -p /opt/ttkpr
docker --version
docker compose version
echo "server ready"
