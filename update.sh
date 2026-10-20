#!/usr/bin/env bash
# Check and update justcpc-exam-server in place, preserving config.json and data/.
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
    case "${1:-}" in
        --help|-h) echo '检查并确认更新：./update.sh；只检查：./update.sh --check；直接同意：./update.sh --yes'; return ;;
        ''|--check|--yes) ;;
        *) echo '未知参数，使用 --help 查看用法。' >&2; exit 2 ;;
    esac
    here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
    cd "$here"
    [[ ! -e .git ]] || { echo '请在独立安装目录运行，不要在源码仓库运行。' >&2; exit 1; }
    root=(sudo); ((EUID == 0)) && root=()
    read -r version base <<< "$(latest_release)"
    [[ -n "${version:-}" && -n "${base:-}" ]] || { echo '无法获取最新正式版，请稍后重试。' >&2; exit 1; }
    current="$(cat .version 2>/dev/null || echo '0.0.0')"
    echo "当前版本：$current；最新正式版：$version"
    if [[ "$(printf '%s\n%s\n' "$current" "$version" | sort -Vr | head -n 1)" == "$current" ]]; then echo '当前已是最新版，无需更新。'; return; fi
    [[ "${1:-}" != --check ]] || return 0
    if [[ "${1:-}" != --yes ]]; then
        read -r -p '是否更新？[y/N]：' answer || answer=''
        [[ "${answer,,}" == y || "${answer,,}" == yes ]] || { echo '已取消更新。'; return; }
    fi
    installed="$(systemctl show "$repo" --property=WorkingDirectory --value 2>/dev/null || true)"
    [[ -z "$installed" || "$installed" == "$here" ]] || { echo "服务安装在 $installed，请到该目录操作。" >&2; exit 1; }
    if [[ -n "$installed" ]]; then "${root[@]}" systemctl stop "$repo"; fi
    excludes=(--exclude='*/.version')
    [[ ! -f config.json ]] || excludes+=(--exclude='*/config.json')

    curl -fL --connect-timeout 10 --max-time 300 "$base/$repo-$version-linux-amd64.tar.gz" |
        "${root[@]}" tar -xz --no-same-owner --strip-components=1 "${excludes[@]}" -C "$here"
    rm -f -- script/justcpc-manager .justcpc-release.json
    "${root[@]}" chmod 600 config.json
    run_user="$(systemctl show "$repo" --property=User --value)"
    [[ -n "$run_user" ]] || { echo '服务未安装，请先执行 bash install.sh。' >&2; exit 1; }
    "${root[@]}" chown -R "$run_user:$(id -gn "$run_user")" justcpc-exam-server script
    "${root[@]}" systemctl restart "$repo"
    "${root[@]}" systemctl is-active --quiet "$repo"
    printf '%s\n' "$version" | "${root[@]}" tee .version >/dev/null
    echo "已更新 $repo $version。"
}
main "$@"; exit
