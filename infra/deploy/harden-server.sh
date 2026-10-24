#!/usr/bin/env bash
# Hardening of the Ubuntu server, run as root once (safe to repeat):
#   - security updates install themselves (unattended-upgrades);
#   - fail2ban bans addresses that keep failing SSH logins (your current address is exempt);
#   - optionally, SSH by key only: pass --disable-password-login ONLY after checking, in a
#     second terminal, that `ssh -i ~/.ssh/ttkpr_deploy root@HOST` logs in without a password.
#
#   ssh -i ~/.ssh/ttkpr_deploy root@HOST 'bash -s' < infra/deploy/harden-server.sh
#   ssh -i ~/.ssh/ttkpr_deploy root@HOST 'bash -s -- --disable-password-login' < infra/deploy/harden-server.sh
#
# The firewall (only 22, 80, 443) is set up by server-setup.sh on every deploy.
set -euo pipefail

DISABLE_PASSWORDS=0
for arg in "$@"; do
  case "$arg" in
    --disable-password-login) DISABLE_PASSWORDS=1 ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q unattended-upgrades fail2ban python3-systemd

echo "==> automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
# Docker itself is updated by hand, outside a demo: an automatic upgrade restarts every
# container. No automatic reboots either (kernel updates wait for a quiet moment).
cat > /etc/apt/apt.conf.d/52ttkpr-unattended << 'EOF'
Unattended-Upgrade::Package-Blacklist { "docker.io"; "containerd"; "runc"; };
Unattended-Upgrade::Automatic-Reboot "false";
EOF
systemctl enable --now unattended-upgrades

echo "==> fail2ban for sshd"
# The address this script is run from is never banned (a few typos must not lock you out).
connection="${SSH_CONNECTION:-}"
operator_ip="${connection%% *}"
cat > /etc/fail2ban/jail.d/ttkpr-sshd.local << EOF
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
ignoreip = 127.0.0.1/8 ::1 ${operator_ip}
EOF
systemctl enable fail2ban
systemctl restart fail2ban
for _ in $(seq 1 10); do fail2ban-client ping > /dev/null 2>&1 && break; sleep 1; done
fail2ban-client status sshd | sed -n '1,4p' || true
echo "    unban an address: fail2ban-client set sshd unbanip <ip>"

if [ "$DISABLE_PASSWORDS" = "1" ]; then
  echo "==> SSH: keys only"
  keys=/root/.ssh/authorized_keys
  if ! grep -qE '^(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-)' "$keys" 2> /dev/null; then
    echo "!! $keys has no keys: password login stays on, or nobody could log in" >&2
    exit 1
  fi
  # 00-: read before 50-cloud-init.conf, and the first value sshd reads wins.
  cat > /etc/ssh/sshd_config.d/00-ttkpr-keys-only.conf << 'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
  # Never reload a broken config: that would lock everyone out.
  sshd -t
  # With socket activation (Ubuntu 22.10+) sshd may not be running: every new connection
  # reads the config anyway, so only a running daemon is reloaded.
  systemctl try-reload-or-restart ssh.service 2> /dev/null \
    || systemctl try-reload-or-restart sshd.service 2> /dev/null || true
  sshd -T | grep -iE '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '
  echo "    keep this session open and check a new key login in another terminal"
else
  echo "==> SSH password login left as is (see --disable-password-login)"
fi
echo "server hardened"
