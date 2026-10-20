#!/usr/bin/env bash
# Internal Linux service setup for justcpc-exam-server.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ "${1:-}" == --run-user && -n "${2:-}" && "$2" != root ]] || { echo '请指定普通运行账号：--run-user USER' >&2; exit 1; }
run_user="$2"
((EUID == 0)) || { echo '此步骤需要 sudo。' >&2; exit 1; }
cat > /etc/systemd/system/justcpc-exam-server.service <<EOF
[Unit]
Description=justcpc-exam-server
After=network.target
[Service]
Type=simple
User=$run_user
Group=$(id -gn "$run_user")
WorkingDirectory=$here
ExecStart=$here/justcpc-exam-server
Environment=GIN_MODE=release
Restart=on-failure
RestartSec=2
KillMode=control-group
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable justcpc-exam-server
systemctl restart justcpc-exam-server
systemctl is-active --quiet justcpc-exam-server
