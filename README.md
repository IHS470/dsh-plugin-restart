# dsh-plugin-restart 2.0.0

DeepSeek Harness 桌面应用的重启按钮：**窗口标题栏一个按钮**，点一下就把整个应用关掉再拉起来。2.0.0 的运行时**就是最初的 v0.1.0**（逐字节一致），仓库里另外附带一个工具，把**「重启 DeepSeek Harness」放进托盘的右键菜单**。

## 两件东西，一次下载都有

| | 是什么 | 怎么用 |
|---|---|---|
| **插件（运行时）** | 标题栏按钮：杀壳 → 拉起应用 → 抬窗两次。没有设置页、没有锁——想连点就连点 | 作为 DSH 插件安装即可 |
| **`tools/patch-shell-tray.mjs`** | 给壳的托盘菜单加一项「重启 DeepSeek Harness」，走壳自己的 `app.relaunch()` + `quitWithoutConfirmation()`（**托盘图标由 Electron 自己移除**，不留幽灵图标） | 见下 |

**为什么托盘那一项不能由插件提供**：托盘在桌面壳的主进程里（`new Tray` / `setContextMenu`）。插件只有两个落脚点——宿主机（纯 Node，没有 Electron API）和页面（preload 只暴露固定的 `dshDesktop`）——都无法向托盘菜单添加任何一项。所以它是一个**本地、可回退**的壳补丁工具，长期解法见 `docs/dsh-restart-api-request.zh.md`（精确到行号）。

## 托盘工具

```bash
node tools/patch-shell-tray.mjs status   # 已安装的 asar 是否带这块补丁
node tools/patch-shell-tray.mjs build    # 从原始备份生成暂存包并逐文件校验
node tools/patch-shell-tray.mjs detach   # 45 秒后由 WMI 创建的独立进程完成切换（推荐）
node tools/patch-shell-tray.mjs swap     # 立即切换
node tools/patch-shell-tray.mjs revert   # 还原原始 asar 并重启
```

自动探测安装位置（`--install=` / `--asar=` → 运行中进程的路径 → 默认位置）；原文件备份为 `app.asar.orig`；若新包起不来，40 秒内**自动还原并重启**。这是对**厂商打包应用**的本地补丁，**应用更新或重装会覆盖 `app.asar`**，重跑 `build` + `detach` 即可。

## 如实说明

- 2.0.0 **不含** 1.0.x 那条线的东西（设置页、重启方式二选一、见证者、残留清理、稳定锁）——按需求回退到 v0.1.0 的行为；那些版本仍保留在各自 tag（`v1.0.0`–`v1.0.4`）。
- 标题栏按钮是**杀进程**式重启，**可能留下幽灵托盘图标**（Windows 对被强杀进程的行为）；托盘那一项不会。
- 只在 Windows 上验证过。
