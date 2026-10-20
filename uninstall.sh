#!/usr/bin/env bash
# Uninstall justcpc-exam-server, optionally removing its configuration and user data.
set -euo pipefail
repo="justcpc-exam-server"
main() {
    case "${1:-}" in
        --help|-h) echo '卸载并询问是否删除数据：./uninstall.sh；保留：--keep-data；删除配置和数据：--delete-data（无法恢复）'; return ;;
        ''|--keep-data|--delete-data) ;;
        *) echo '未知参数，使用 --help 查看用法。' >&2; exit 2 ;;
    esac
    here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    cd "$here"
    [[ ! -e .git ]] || { echo '请在独立安装目录运行，不要在源码仓库运行。' >&2; exit 1; }
    root=(sudo); ((EUID == 0)) && root=()
    data="$(sed -n 's/.*"data"[[:space:]]*:[[:space:]]*"\([^"\]*\)".*/\1/p' config.json 2>/dev/null | head -n 1 || true)"
    data="$(realpath -m -- "${data:-./data}")"
    purge=false
    if [[ "${1:-}" != --keep-data ]]; then
        echo "可同时删除以下内容（无法恢复）：$here/config.json ${data:-}"
        if [[ "${1:-}" == --delete-data ]]; then purge=true; else
            read -r -p '是否同时删除配置和用户数据？[y/N]：' answer || answer=''
            [[ "${answer,,}" != y && "${answer,,}" != yes ]] || purge=true
        fi
    fi
    if [[ "$purge" == true && -n "$data" ]]; then
        owner_home="$(getent passwd "${SUDO_USER:-${USER}}" | cut -d: -f6)"
        case "$data" in /|/home|/root|/tmp|/var|/var/lib|/opt|/srv|/mnt|/media|/etc|/etc/*|/usr|/usr/*|/sys|/sys/*|/proc|/proc/*|/dev|/dev/*|/run|/run/*|/bin|/bin/*|/sbin|/sbin/*|/lib|/lib/*|/lib64|/lib64/*|"$HOME"|"$owner_home") echo '拒绝删除系统目录或用户主目录。' >&2; exit 1 ;; esac
        [[ "$data" != "$here" && "$here" != "$data/"* ]] || { echo '数据路径不能是安装目录或其上级。' >&2; exit 1; }
    fi
    installed="$(systemctl show "$repo" --property=WorkingDirectory --value 2>/dev/null || true)"
    [[ -z "$installed" || "$installed" == "$here" ]] || { echo "服务安装在 $installed，请到该目录操作。" >&2; exit 1; }
    if [[ -n "$installed" ]]; then "${root[@]}" systemctl stop "$repo"; fi
    "${root[@]}" systemctl disable "$repo" 2>/dev/null || true
    "${root[@]}" rm -f -- "/etc/systemd/system/$repo.service"
    "${root[@]}" systemctl daemon-reload
    if [[ "$purge" == true ]]; then
        [[ -z "$data" ]] || "${root[@]}" rm -rf -- "$data"
        "${root[@]}" rm -f -- config.json
    fi
    "${root[@]}" rm -rf -- justcpc-exam-server script
    "${root[@]}" rm -f -- install.sh update.sh uninstall.sh README.md 使用说明.txt .version .justcpc-release.json start.sh install-service.sh config.example.json
    echo "已卸载 $repo；删除配置和数据：$purge。"
}
main "$@"; exit
