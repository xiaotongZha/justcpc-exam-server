#!/usr/bin/env bash
# Check and update justcpc-exam-server in place, preserving config.json and data/.
set -euo pipefail
repo="justcpc-exam-server"
latest_release() {
    for api in "https://gitee.com/api/v5/repos/zhaxt/$repo/releases/latest" "https://api.github.com/repos/xiaotongZha/$repo/releases/latest"; do
        tag="$(curl -fsSL --connect-timeout 10 --max-time 30 --retry 2 --retry-delay 1 "$api" |
            sed -nE 's/.*"tag_name"[[:space:]]*:[[:space:]]*"(v?[0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' | head -n 1)" || continue
        [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        printf '%s %s\n' "${tag#v}" "$tag"
    done | sort -k1,1Vr | head -n 1
}
download_release() {
    archive="$(mktemp "$here/.download-XXXXXX.tar.gz")"
    trap 'rm -f -- "$archive"' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    asset="$repo-$version-linux-amd64.tar.gz"
    prefix="$repo-$version-linux-amd64"
    for site in "https://gitee.com/zhaxt/$repo" "https://github.com/xiaotongZha/$repo"; do
        base="$site/releases/download/$tag"
        echo "下载 $repo $version：$site"
        expected="$(curl -fsSL --connect-timeout 10 --max-time 30 --retry 2 --retry-delay 1 "$base/$asset.sha256")" || continue
        expected="${expected%%[[:space:]]*}"
        [[ "$expected" =~ ^[[:xdigit:]]{64}$ ]] || { echo '校验文件无效，尝试另一来源。' >&2; continue; }
        if ! curl -fL --connect-timeout 10 --max-time 1800 --speed-limit 1 --speed-time 60 \
            --retry 2 --retry-delay 1 -o "$archive" "$base/$asset"; then
            echo '下载失败，尝试另一来源。' >&2; continue
        fi
        actual="$(sha256sum "$archive")"; actual="${actual%% *}"
        [[ "$actual" == "${expected,,}" ]] || { echo '校验失败，尝试另一来源。' >&2; continue; }
        tar -tzf "$archive" "$prefix/config.json" "$prefix/install.sh" "$prefix/update.sh" "$prefix/uninstall.sh" "$prefix/.version" "$prefix/script/register-service.sh" "$prefix/justcpc-exam-server" >/dev/null || { echo '发行包不完整，尝试另一来源。' >&2; continue; }
        echo '发行包校验通过。'
        return 0
    done
    echo '所有下载来源均失败，未停止服务或覆盖程序。' >&2
    return 1
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
    read -r version tag <<< "$(latest_release)" || true
    [[ -n "${version:-}" && -n "${tag:-}" ]] || { echo '无法获取最新正式版，请稍后重试。' >&2; exit 1; }
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
    run_user="$(systemctl show "$repo" --property=User --value)"
    [[ -n "$run_user" ]] || { echo '服务未安装，请先执行 bash install.sh。' >&2; exit 1; }
    download_release
    if [[ -n "$installed" ]]; then "${root[@]}" systemctl stop "$repo"; fi
    excludes=(--exclude='*/.version')
    [[ ! -f config.json ]] || excludes+=(--exclude='*/config.json')

    "${root[@]}" tar -xzf "$archive" --no-same-owner --strip-components=1 "${excludes[@]}" -C "$here"
    rm -f -- script/justcpc-manager .justcpc-release.json
    "${root[@]}" chmod 600 config.json
    "${root[@]}" chown -R "$run_user:$(id -gn "$run_user")" justcpc-exam-server script
    "${root[@]}" systemctl restart "$repo"
    "${root[@]}" systemctl is-active --quiet "$repo"
    printf '%s\n' "$version" | "${root[@]}" tee .version >/dev/null
    echo "已更新 $repo $version。"
}
main "$@"; exit
