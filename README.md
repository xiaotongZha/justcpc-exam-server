# justcpc-exam-server

## Windows

[GitHub 下载](https://github.com/xiaotongZha/justcpc-exam-server/releases/latest) · [Gitee 下载](https://gitee.com/zhaxt/justcpc-exam-server/releases)

完整解压，按需编辑 `config.json`，双击 `justcpc-exam-server.exe`。停止服务用启动窗口“停止并退出”。Windows 不使用以下脚本。

## Linux 安装

Linux amd64、systemd。 脚本使用 curl、tar 等 Linux 命令，无需安装编程环境。

```bash
mkdir -p ~/justcpc-exam-server && cd ~/justcpc-exam-server
curl -fL https://gitee.com/zhaxt/justcpc-exam-server/raw/master/install.sh -o install.sh ||
  curl -fL https://raw.githubusercontent.com/xiaotongZha/justcpc-exam-server/master/install.sh -o install.sh
bash install.sh
```

自动下载最新正式版，解压到当前目录并启动服务；安装后可看到 `update.sh` 和 `uninstall.sh`。

考生访问 `http://服务器IP:10293/`，监考员访问 `/admin`；放行 TCP 10293。初始密码与试题解压密码见服务日志。

## 更新与卸载

```bash
./update.sh             # 检查版本，确认后原地更新
./uninstall.sh          # 卸载，询问是否删除配置和数据，默认保留
./install.sh --logs     # 查看实时日志，Ctrl+C 退出
./install.sh --restart  # 修改 config.json 后重启
```

更新保留 `config.json` 和用户数据，不创建备份；失败可重跑 `bash install.sh`。卸载可用 `--keep-data` 明确保留，或 `--delete-data` 明确删除（无法恢复）。

[开发说明](docs/DEVELOPMENT.md)
