# dsh-remote-workspace

一个在另一台机器上工作的 DSH 插件。它管理那台机器的仓库和 worktree，把 harness 的文件、shell 和终端工具路由到你
打开的目录，并在右侧边栏加上终端标签页。模型看到的是普通本地路径。

[English](README.md) | 中文

![在远端 worktree 里执行工具的会话](docs/screenshots/zh/08-session.png)

| 机器列表 | 已连接 | 切出的 worktree |
| --- | --- | --- |
| ![机器列表](docs/screenshots/zh/01-section.png) | ![已连接的机器与仓库](docs/screenshots/zh/03-connected.png) | ![已创建的 worktree](docs/screenshots/zh/06-worktree-created.png) |

## 环境要求

- Node 22.19+ 或 24+，以及按平时方式配好的 `ssh`。
- DSH `0.1.6-alpha.2` 或 `0.1.5-rc.2`。其他版本未测试。

## 安装

```sh
dsh plugin --profile web add @lengmoxxl/dsh-remote-workspace
```

插件要接管 base profile 提供的服务，而 host plane 每项服务只允许一个实现。把这四行加进
`$DSH_HOME/profiles/web/cordis.patch.yml`；缺了它们插件仍会加载、但不会路由，并在 stderr 上说明。

```yaml
- id: subprocess
  disabled: true
- id: fs-sandbox
  disabled: true
- id: bash-sandbox
  disabled: true
- id: pwsh-sandbox
  disabled: true
```

然后用 `dsh --profile web` 启动。包里带着构建好的 `lib/`，本机不编译任何东西。改插件本身时，改为 clone
仓库、`npm install && npm run build`，再添加检出目录。

## 权限与风险

这个插件按设计就是高权限的：它会在你登记的每台机器上、以 SSH 账号的身份运行命令、开终端、读写文件。持有某台机器
token 且能到达其回环端口的人，等同于能以该账号行事。

- host 半边接管 `ctx.fs`、`ctx.subprocess`、`ctx.shell`、`ctx.tty`；上面 `cordis.patch.yml` 里禁用的四个官方
  实现正是为此让位，被路由到的路径改由本插件应答。
- agent 二进制从本仓库的 GitHub Releases 下载、用 `SHA256SUMS` 校验、上传到机器的 `~/.dsh/remote-agent/` 并启动。
  它只监听 `127.0.0.1`、经 `ssh -L` 到达；其 token 文件与本机节点登记表的权限都是 `600`。
- `node-pty` 是带预编译绑定的原生依赖：本机侧边栏的终端经由它运行。
- 对外网络只有 GitHub Releases 下载与你配置的 `ssh` 连接，此外不向外发任何东西。

## 功能

- 通过 SSH 添加机器，以及一个操作本机的内置 `Local` 机器。agent 从本仓库 Releases 下载、用 `SHA256SUMS` 校验、
  经 `ssh -L` 到达，所以机器上不需要安装任何东西。
- 把任意目录登记为仓库；不要求是 git 仓库，普通目录之后也可以变成仓库。
- 从仓库切 worktree、纳入已存在的 worktree、或直接打开仓库目录；删除 worktree 时可以选择连分支一起删。
- 把目录打开为工作区后，文件、shell 和终端工具都跑在拥有它的那台机器上。
- 在右侧边栏开终端标签页，每个会话一个。**终端**按钮会先列出该会话中仍在运行的终端（包括刷新页面或关闭标签后脱离
  的那个），可以重新接入，也可以结束。
- agent 可以在**开着标签的**终端里干活：列出终端、读输出、输入文本和按键（包括 `ctrl+c`）、等待输出出现。它不会
  创建或关闭终端。

## 使用

**设置 → 远程工作区。** 用 SSH 目标和 token（任意字符串，是 daemon 的共享密钥）添加机器；`Local` 两项都不需要。
机器会自动连接，一直连不上的显示**连接**按钮。登记仓库后，用每行的菜单打开、关闭或移除它持有的东西。

**终端。** 右侧边栏的添加控件里有一个**终端**按钮：它会列出该会话在运行的终端，也可以新建一个。面板状态栏里的
**管理终端**会在当前标签旁再开一个终端标签页，由列表让你接入已有 shell 或新建一个；已被其他标签打开的终端标为
**已打开**，选中它会切到那个标签。关闭标签只是让它脱离：
shell 会继续在主机上运行，并在列表里显示为已断开；要结束它，用列表里每行的关闭按钮。隐藏标签、
切换会话、收起边栏同样不会中断它。

**终端外观。** 字体、字号、行高、回滚行数和光标闪烁在 shell 自己的设置里：**插件 → remote-workspace**。
它们存在设置文档里，所以这个部署的每个页面画出来的终端都一样。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `worktreeRoot` | `~/.dsh/worktrees` | 每台机器上切出的检出所在的根目录。 |
| `shell` | 未设置 | 侧边栏终端运行的程序；未设置则用机器自己的登录 shell。 |
| `shellArgs` | `['-l']` | `shell` 之后的参数；`shell` 未设置时忽略。 |
| `graceMs` | `3000` | 关闭终端时留给它退出的时间（毫秒）。 |
| `detachGraceMs` | `0` | 安全阀：终端 socket 断开（刷新页面、连接掉线）后保留多久等待重新接入（毫秒）。`0`（默认）表示只要进程还在就一直保留。 |

MIT
