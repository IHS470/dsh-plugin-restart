# dsh-plugin-restart

[English](README.en.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-plugin-restart)](https://www.npmjs.com/package/dsh-plugin-restart)
[![test](https://github.com/IHS470/dsh-plugin-restart/actions/workflows/ci.yml/badge.svg)](https://github.com/IHS470/dsh-plugin-restart/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-plugin-restart)](LICENSE)

**装在 DeepSeek Harness 桌面版窗口标题栏里的重启按钮。** 点一下、确认一下，应用自己关掉再起来，
窗口直接出现在最前面——不会缩进托盘，也不会弹「应用无法启动或已意外停止」。

- **一个按钮**：挂在标题栏里、原生"最小化"左边，位置由 caption overlay 的矩形实时算出，
  任何 DPI 下都贴着原生按钮而不重叠；全屏时那条带子消失，按钮跟着消失。
- **二次确认是一个可见的浮层**，不是"按钮变红再点一次"——它紧挨着关闭按钮，而"没反应"是这里最坏的反馈。
- **重启即前台**：应用起来后助手会再戳一次，桌面壳对"第二次启动"的回应是聚焦自己的窗口。
- **零依赖、零配置、零磁盘状态**（除了助手日志），不需要任何 DSH 版本特有的设置命名空间。

## 安装

```sh
dsh plugin --profile desktop add dsh-plugin-restart
```

（`desktop` 是桌面版 profile 的名字；终端里用 `dsh web` 起的话换成 `--profile web`。）

然后**重启一次 DeepSeek Harness**（让 bundle 进入组合树），刷新页面即可在标题栏看到按钮。

> 标题栏那条带子只有一个位置：如果已经有别的插件也往这里放按钮，两个会正好叠在一起。

**要求**：Windows + DeepSeek Harness 桌面版（Electron 壳）。其它平台可以安装，但按钮会明确报告
"重启能力还没加载"——助手的整套动作依赖 `cmd` / `taskkill` / `start`，在这些平台上没有等价实现，
而**关掉一个自己拉不回来的壳比不提供按钮更糟**。

## 它是怎么做到的

DSH 桌面壳把 Host 跑成**普通 Node 子进程**（`dsh-desktop-host`），所以插件里 `require('electron')`
拿不到 `app`、没有 `relaunch()`；而桌面壳持有**单实例锁**，直接再启动一个只会聚焦旧窗口。
所以重启由四件事组成，每一件都是被实际行为逼出来的：

1. **先关桌面壳，再让 Host 退出。** 桌面壳把 Host 的**任何**退出都判成崩溃——连干净的
   `process.exit(0)` 也一样——然后弹「应用无法启动或已意外停止」并把 Host 的 stderr 尾巴贴上去，
   每次重启多一份崩溃报告。反过来先关壳，壳就什么都来不及看见。Host 配合这一点：它不再定时自杀，
   而是**轮询桌面壳的 pid**，等它消失后才退出（4 秒兜底：助手没起来时仍然退出，让壳自己的恢复框
   至少提供重启）。
2. **关壳按 pid，绝不用 `/T`。** 助手本身是 `shell → host → 助手` 的孙进程，树杀会在重启前先把自己
   杀掉；1.5 秒还没走就补一次，并确认 `alive=false` 而不是假定。
3. **用 `start` 启动应用**，和资源管理器一样，新实例拿到正常可见的窗口、不在旧进程树里。
4. **启动前必须删掉 `ELECTRON_RUN_AS_NODE`。** 桌面壳就是靠它把 Host 跑成普通 Node 的，助手的
   环境里因此带着它；原样传给应用，Electron 会以"跑 Node"的方式启动：不开窗口、立刻退出，
   用户看到的就是「应用直接关掉了，没有重启」。

另外：页面上**不会**用 `window.close()` 收尾——桌面壳把窗口关闭事件改成**隐藏到托盘并继续运行**，
而且单实例锁属于进程而不是窗口，关窗口什么也释放不了。所以窗口留着显示「正在重启…」，由进程退出
把它一起带走。

助手日志写在 `$DSH_HOME/dsh-plugin-restart/relaunch.log`，每一步都有时间戳，反馈问题时直接附上它。

## 安全

- 所有路由都过 DSH 的同源信任栅栏：跨站标记、异源 `Origin`、非 loopback 的 `Host` 一律 403，
  存在 Host 自己的 `connection` 守卫时以它为准。重启接口只接受 `POST`。
- 交给助手的 web 地址取自**浏览器刚发出的那次请求的 `Host` 头**，并且只接受 loopback——
  伪造的 `Host` 不能把助手指向别的机器。
- 除了 `relaunch.log`，插件**不写任何文件、不上报任何数据**；没有网络请求。
- 它只会做一件事：重启本机的这个应用。

## 验证

三个 harness，全部用真实代码跑，`npm test` 一次跑完（`test/relaunch.test.mjs` 只在 Windows 上真跑，
其它平台打印 SKIP 并以 0 退出）：

| 检查 | 脚本 | 覆盖 |
|---|---|---|
| 宿主半边 | `test/host.test.mjs` | 能力探测（纯 Node host 下 `available === false` 且说明原因）、`POST /restart` 回 `unavailable` 而不是假装重启了、信任栅栏四种拒绝路径 + 同源放行、Host 守卫的否决与放行、未知路径与 `GET /restart` 都是 404 |
| 浏览器半边 | `test/client.test.mjs` | 桩掉 DOM/fetch 后加载 `client.js`：按钮挂进窗口 chrome、`--dsh-restart-right` 由 caption overlay 矩形算出（桩：1280 宽 → 142px）、高度跟随 `--dsh-windows-titlebar-height`、点一下**弹出可见浮层**、取消不发请求、确认后**只发一次** POST 并显示「正在重启…」、**绝不 `window.close()`**、提示活过浮层的 8 秒自动关闭计时器、overlay 报告不可见时不挂载、dispose 后 chrome 被移除 |
| 重启助手 | `test/relaunch.test.mjs` | 用桩跑真实 `lib/relaunch.mjs`：一次性进程冒充桌面壳与 Host、`.cmd` 冒充应用（每次启动追加一行并回报 `%ELECTRON_RUN_AS_NODE%`）、401 桩端口冒充 web 端口。**三种情形**（Host 自己退出 / Host 赖着不走 / 没拿到 web 地址）断言：壳先关且确认 `alive=false`、Host 该留就留该关就关、**应用只在两者都消失之后才启动**、**`ELECTRON_RUN_AS_NODE` 绝不到达应用**、启动三次（重启一次 + 抬窗两次）、**从不使用 `taskkill /T`** |

```sh
npm test
```

## 许可

MIT © 2026 IHS470 · 详见 [LICENSE](LICENSE)
