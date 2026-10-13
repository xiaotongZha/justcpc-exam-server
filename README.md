# JustCPC 机房考试服务（Exam Server）

面向**离线机房**的局域网考试服务：选手用浏览器登录、下载题面、提交代码；现场管理员导入比赛包、控制考试、导出提交包，交给赛后评测系统。

- **单文件、无外部依赖**：纯 Go 后端 + 内嵌前端，SQLite 数据库，跨 Windows / Linux。
- **离线可用**：考试期间只需机房局域网，不访问公网。
- **只收不判**：本服务不评测、不显示分数与排名；产出为可导入评测系统的**提交包**。
- 通过**比赛包导入 / 提交包导出**与赛后评测系统交接，不共享数据库。

## 快速开始（现场管理员）

1. 把发行包解压到**任意可写目录**（Windows 请勿放 `Program Files`）。
2. 启动：
   - Windows：双击 `start-exam.bat`
   - Linux：`./start-exam.sh`
3. 浏览器访问：
   - 选手入口 `http://<本机IP>:10293/`
   - 管理员入口 `http://<本机IP>:10293/admin`
4. 初始管理员账号/密码在发行包自带的 `config.json` 里（启动日志也会打印）。**首次登录后请立即修改管理员密码。**

## 目录与数据

运行数据全部在程序目录下，**首次运行自动创建**，无需手工配置：

```
data/
├── exam.sqlite        # SQLite 主库（考试/题目/考生/提交/审计）
└── store/
    ├── contest-statements/   # 比赛题面 PDF
    ├── submissions/<id>/     # 选手提交源码
    └── imports/              # 导入暂存
```

- 覆盖升级：**保留 `data/` 与 `config.json`**，只替换可执行文件。
- 备份/迁移：**整包拷贝 `data/`**（数据库与 `store/` 必须一起，缺一不可）。

## 配置（config.json）

| 字段 | 说明 |
|---|---|
| `data` | 数据目录，默认 `./data` |
| `listen` | 监听地址，默认 `0.0.0.0:10293` |
| `admin_username` / `admin_password` | 首次启动创建的管理员账号 |
| `session_secret` | 会话签名密钥，至少 32 字节 |
| `statement_password` | 题面加密压缩包密码（开考时公布），默认 `GoJustCPC` |

`session_secret`、`admin_password` 也可分别用环境变量 `JUSTCPC_EXAM_SESSION_SECRET`、`JUSTCPC_EXAM_ADMIN_PASSWORD` 提供；配置文件路径可用 `JUSTCPC_EXAM_CONFIG` 指定。

## 从源码构建

```bash
# 本地运行（需先准备 config.json）
go run ./src

# 打包 Windows / Linux 发行版（压缩包输出到 release/）
./script/build-release.sh
```

## 主要接口

- 选手：`/api/login`、`/api/exam`、`/api/problems`、`/api/statement`、`/api/problems/:label/submissions`、`/api/early-submit`、`/api/events`
- 管理：`/api/admin/import`、`/api/admin/export`、`/api/admin/exam/{schedule,restart,:action}`、`/api/admin/contestants`、`/api/admin/rules`、`/api/admin/audit`、`/api/admin/events`
