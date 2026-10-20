#!/usr/bin/env bash
# Install the latest Linux release of justcpc-exam-server.
set -euo pipefail
repo="justcpc-exam-server"
latest_release() {
    for site in "https://gitee.com/zhaxt/$repo" "https://github.com/xiaotongZha/$repo"; do
        url="$(curl -fLsSI --connect-timeout 10 --max-time 30 -o /dev/null -w '%{url_effective}' "$site/releases/latest")" || continue
        tag="${url##*/}"
        [[ "$url" == "$site/releases/tag/$tag" && "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        printf '%s %s\n' "${tag#v}" "$site/releases/download/$tag"
    done | sort -k1,1Vr | head -n 1
}
main() {
    root=(sudo); ((EUID == 0)) && root=()
    case "${1:-}" in
        --logs) exec "${root[@]}" journalctl -u "$repo" -n 100 -f ;;
        --status) exec "${root[@]}" systemctl status "$repo" --no-pager ;;
        --restart) exec "${root[@]}" systemctl restart "$repo" ;;
        --help|-h) echo '安装最新版：bash install.sh；日志：./install.sh --logs；重启：./install.sh --restart'; return ;;
        '') ;;
        *) echo '未知参数，使用 --help 查看用法。' >&2; exit 2 ;;
    esac
    here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    cd "$here"
    [[ ! -e .git ]] || { echo '请在独立安装目录运行，不要在源码仓库运行。' >&2; exit 1; }
    root=(sudo); ((EUID == 0)) && root=()
    [[ "$(uname -sm)" == 'Linux x86_64' ]] || { echo '此发行包支持 Linux amd64。' >&2; exit 1; }
    run_user="${SUDO_USER:-${USER:-}}"
    [[ -n "$run_user" && "$run_user" != root ]] || { echo '请使用普通账号执行 bash install.sh。' >&2; exit 1; }
    read -r version base <<< "$(latest_release)"
    [[ -n "${version:-}" && -n "${base:-}" ]] || { echo '无法获取最新正式版，请稍后重试。' >&2; exit 1; }
    installed="$(systemctl show "$repo" --property=WorkingDirectory --value 2>/dev/null || true)"
    [[ -z "$installed" || "$installed" == "$here" ]] || { echo "服务安装在 $installed，请到该目录操作。" >&2; exit 1; }
    if [[ -n "$installed" ]]; then "${root[@]}" systemctl stop "$repo"; fi
    excludes=(--exclude='*/.version')
    [[ ! -f config.json ]] || excludes+=(--exclude='*/config.json')

    curl -fL --connect-timeout 10 --max-time 300 "$base/$repo-$version-linux-amd64.tar.gz" |
        "${root[@]}" tar -xz --no-same-owner --strip-components=1 "${excludes[@]}" -C "$here"
    rm -f -- script/justcpc-manager .justcpc-release.json
    "${root[@]}" chmod 600 config.json
    "${root[@]}" chown -R "$run_user:$(id -gn "$run_user")" justcpc-exam-server script
    "${root[@]}" chown "$run_user:$(id -gn "$run_user")" "$here" config.json
    "${root[@]}" bash ./script/register-service.sh --run-user "$run_user"
    printf '%s\n' "$version" | "${root[@]}" tee .version >/dev/null
    echo "已安装 $repo $version。查看日志：./install.sh --logs"
}
# Parse the complete function before extraction replaces this script.
main "$@"; exit
