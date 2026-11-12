#!/bin/bash
# Boot script for the k6 load generator. Installs k6, clones the repo and
# leaves a `run.sh` in /home/ubuntu/mercur that runs a benchmark under tmux.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git tmux

K6_VERSION=${K6_VERSION:-v2.3.0}
curl -fsSL "https://github.com/grafana/k6/releases/download/${K6_VERSION}/k6-${K6_VERSION}-linux-amd64.tar.gz" \
  | tar -xz -C /tmp
install -m 755 "/tmp/k6-${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6

cat > /etc/security/limits.d/k6.conf <<'EOF'
* soft nofile 262144
* hard nofile 262144
EOF
sysctl -w net.ipv4.ip_local_port_range="1024 65535"
sysctl -w net.ipv4.tcp_tw_reuse=1

sudo -u ubuntu git clone --depth 1 https://github.com/vholik/mercur-perfomance-test.git /home/ubuntu/mercur
touch /home/ubuntu/READY
chown ubuntu:ubuntu /home/ubuntu/READY
