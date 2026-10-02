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
"重启能力还没加载"——助手的整套动作依赖 `taskkill` 与 Windows 的单实例行为，在这些平台上没有等价
实现，而**关掉一个自己拉不回来的壳比不提供按钮更糟**。同样的判断也用在"应用本身不在"的时候：可执行
文件被移走、卸载，或者指向的根本不是可执行镜像时，能力直接报 `app-unusable`，那一下不会关掉你的应用。

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
   杀掉；1.2 秒还没走就补一次，并确认 `alive=false` 而不是假定。
3. **壳一消失就启动应用，不等旧 Host。** 旧 Host 在壳死后约 0.1 秒自己就走，而新应用要好几秒才轮到
   自己的 Host 去占端口——所以"先等 Host 退出、再睡 400 毫秒等单实例锁"纯粹是加在用户身上的串行等待。
   现在是：确认壳没了 → 立刻启动应用 → 再去确认旧 Host 已退出（与新应用自己的启动并行）。
   **实测：从助手启动到应用被拉起，~0.37 秒（0.1.0 是 ~0.85 秒）。** 应用自身的启动时间不变。
4. **直接启动可执行文件，并校验这次启动真的成立。** 直接 spawn 让助手拿到应用的 pid，于是能分辨
   "真的起来了"和"输了单实例竞争、秒退"——后者会被检测到（连同退出码）并重试，最多三次。
5. **启动前必须删掉 `ELECTRON_RUN_AS_NODE`。** 桌面壳就是靠它把 Host 跑成普通 Node 的，助手的
   环境里因此带着它；原样传给应用，Electron 会以"跑 Node"的方式启动：不开窗口、立刻退出，
   用户看到的就是「应用直接关掉了，没有重启」。
6. **应用答话之后再戳它。** 桌面壳对"第二次启动"的回应是聚焦自己的窗口（`second-instance`），这是插件
   对窗口可见性唯一的抓手；默认在答话后 2 秒 / 6 秒 / 12 秒各戳一次（`DSH_RESTART_POKE_MS` 可改），
   覆盖"答话时窗口还没进 workspace"的空档。戳晚了也没关系——如果那时应用已经不在了，这一戳就变成它。

另外：页面上**不会**用 `window.close()` 收尾——桌面壳把窗口关闭事件改成**隐藏到托盘并继续运行**，
而且单实例锁属于进程而不是窗口，关窗口什么也释放不了。所以窗口留着显示「正在重启…」，由进程退出
把它一起带走；如果 5 秒后这个页面还在，它会直接说「重启似乎没有生效」，而不是一直转。

顺手也把下面这些做进去了：一次只允许一个重启（Host 持锁，第二次点击回 `busy`，陈旧锁会自动清掉）、
`GET /dsh-restart/state` 报出插件版本 / 是否正在重启 / 上一次的结果、助手参数改成具名（`--host=` /
`--web=` / `--lock=`，同时仍接受旧的位置参数——助手的文件是启动时现读的，所以升级后的第一次重启真的
是"旧 Host + 新助手"）。

## 诊断

都在 `$DSH_HOME/dsh-plugin-restart/`：

| 文件 | 内容 |
|---|---|
| `relaunch.log` | 每一步的时间戳；`done ok=… attempts=… pokes=… shellGone=…ms appStarted=…ms total=…ms` 是总账 |
| `app.log` | **应用自己**的 stdout/stderr，每次重启重写（一次启动一份）。0.1.0 的"应用没回来"如果当时有这个文件，一眼就能看出原因 |
| `last-run.json` | 机器可读的摘要：`ok` / `answered` / `attempts` / `appExit` / `pokes` / `gaps` / `ms`，`/dsh-restart/state` 的 `last` 就是它 |
| `relaunch.lock` | 重启进行中的锁；助手完成时删除，超过 3 分钟视为陈旧并自动清理 |

## 安全

- 所有路由都过 DSH 的同源信任栅栏：跨站标记、异源 `Origin`、非 loopback 的 `Host` 一律 403，
  存在 Host 自己的 `connection` 守卫时以它为准。重启接口只接受 `POST`。
- 交给助手的 web 地址取自**浏览器刚发出的那次请求的 `Host` 头**，并且只接受 loopback——
  伪造的 `Host` 不能把助手指向别的机器。
- 除了 `$DSH_HOME/dsh-plugin-restart/` 下那几个诊断文件（日志、`last-run.json`、进行中的锁），插件
  **不写任何文件、不上报任何数据**；没有网络请求。
- 它只会做一件事：重启本机的这个应用。

## 验证

三个 harness，全部用真实代码跑，`npm test` 一次跑完（`test/relaunch.test.mjs` 只在 Windows 上真跑，
其它平台打印 SKIP 并以 0 退出）：

| 检查 | 脚本 | 覆盖 |
|---|---|---|
| 宿主半边 | `test/host.test.mjs` | 能力探测（纯 Node host 下 `available === false` 且说明原因）、`POST /restart` 回 `unavailable` 并带上原因、`/state` 报出插件版本 / `busy` / `last`、**一把锁只放一个重启进来**（新鲜锁 → `busy: true` 且 `POST` 回 `{ok:false,code:'busy'}`；10 分钟前的陈旧锁不算数）、信任栅栏四种拒绝路径 + 同源放行、Host 守卫的否决与放行、未知路径与 `GET /restart` 都是 404 |
| 浏览器半边 | `test/client.test.mjs` | 桩掉 DOM/fetch 后加载 `client.js`：按钮挂进窗口 chrome、`--dsh-restart-right` 由 caption overlay 矩形算出（桩：1280 宽 → 142px）、高度跟随 `--dsh-windows-titlebar-height`、点一下**弹出可见浮层**、取消不发请求、确认后**只发一次** POST 并显示「正在重启…」、**绝不 `window.close()`**、5 秒后仍没生效就改口「重启似乎没有生效」而不是一直转、提示活过浮层的 8 秒自动关闭计时器、`busy` 回执有专门文案、**Enter 确认但在输入框里不确认**、overlay 报告不可见时不挂载、dispose 后 chrome 被移除 |
| 重启助手 | `test/relaunch.test.mjs` | 用桩跑真实 `lib/relaunch.mjs`（Node 可执行文件 + `NODE_OPTIONS` 注入探针冒充应用、一次性进程冒充桌面壳与 Host、401 桩端口冒充 web 端口），**六种情形**：Host 自己退出 / Host 赖着不走 / 没拿到 web 地址 / 可执行文件不存在 / 应用路径是脚本 / 第一次启动输了单实例竞争。断言：壳先关且确认 `alive=false`、**应用在旧 Host 被确认消失之前就已经启动**（这正是 0.1.1 提速的地方）、Host 该留就留该关就关、**`ELECTRON_RUN_AS_NODE` 绝不到达应用**、**启动不了的路径一律不关壳**、输锁竞争的启动带着退出码重试、应用输出被 `app.log` 收下、`last-run.json` 的 `ok/attempts/appExit/pokes/gaps/ms` 与日志一致、锁一定被释放、**从不使用 `taskkill /T`**、并且旧的位置参数形式仍然能解析 |

```sh
npm test
```

## 许可

MIT © 2026 IHS470 · 详见 [LICENSE](LICENSE)
