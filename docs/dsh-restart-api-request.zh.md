# 功能请求：让插件能请求桌面壳「退出」或「重启」

写于 dsh-plugin-restart 0.5.0 / 0.6.x 的开发过程中。以下内容全部读自本机安装的桌面壳
（`resources/app.asar` → `lib/main.js`、`lib/preload-app.cjs`；Electron 44，`@deepseek-ai/dsh-desktop`
0.2.0-rc.2），行号对应这个版本。

## 今天的插件做不到什么

重启类插件需要的是「**应用退出，然后再起来**」。它当然可以自己结束掉壳的进程——dsh-plugin-restart
就是这么做的——但它**无法请求壳按照应用自己的方式退出**：自己的收尾流程、自己的日志，以及
**由 Electron 移除、而不是被强杀**的托盘图标。

两个看起来应该能用、实际不能用的做法：

1. **关闭窗口。** `lib/main.js` 会把窗口关闭变成「藏进托盘」，而 `background-close-confirmed`
   （`lib/main.js:11953`，由 `10924-10936` 的对话框写入）是让这次隐藏**静默**的标记。它的存在意味着
   「用户已经同意：关闭就隐藏」——**与「请求退出」正好相反**。
2. **IPC 接口。** 这个版本里主进程响应的全部通道：

   ```
   DESKTOP_IPC.boot, bootFailed, browserAcquire, browserRelease, deviceInfo, directoryPick,
   localeBootstrap, onboardingApiKey, shortcutsCloseWindow, shortcutsEdit, shortcutsGet,
   shortcutsRecording, updatesOpen, updatesStatus, windowsMenu,
   MANDATORY_IPC.action, status, PLATFORM_IPC.bounds, close, open,
   UPDATE_DIALOG_IPC.respond, status,
   WELCOME_IPC.analytics, analyticsEnabled, cancel, copyLink, saveApiKey, skip, start, takeNotice
   ```

   里面没有 `quit`、`exit` 或 `restart`。而 preload 暴露的 `dshDesktop` 只有 `browser`、`deviceInfo`、
   `shortcuts`、`updates`、`closeWindow`——最后那个是快捷键录制窗口自己的关闭。

## 壳里其实已经有这个能力

`lib/main.js` 里：

- `10918-10924`：`quitWithoutConfirmation()` —— 注释写着「Quit without the task confirmation; the caller has
  already decided the application must stop」，它设置 `skipQuitConfirmation` 并调用 `app.quit()`。
- `10945-10947`：注释点名了它的调用者：「crash recovery exit and restart, and the development restart
  command」。
- `11918`、`11946`：菜单/托盘里的 `quitApplication` → `app.quit()`。
- 本地化文案里已经带了重启项：`restartAppHostMenu: "Restart App and Host"`、
  `restartApplication: "Restart"`。

**能力是现成的，缺的只是一道门。**

## 建议的三处改动

1. **一个通道名**，加在 `DESKTOP_IPC` 里其它名字旁边：

   ```js
   restart: "dsh-desktop:restart",
   ```

2. **一个 handler**，放在现有 handler 旁边，用文件里已经有的同源断言
   （`assertDesktopSender(event, ["app"])`）：

   ```js
   ipcMain.handle(DESKTOP_IPC.restart, async (event) => {
     assertDesktopSender(event, ["app"])
     const window = getWindow()
     if (window === undefined || window.isDestroyed()) return { ok: false, reason: "no-window" }
     app.relaunch()
     quitWithoutConfirmation()
     return { ok: true }
   })
   ```

   `quitWithoutConfirmation()` 故意跳过「正在运行的任务会被中断」那个确认框：已经自己弹过确认的调用方
   （比如插件自己的设置页）不该被问两次。

3. **在 `lib/preload-app.cjs` 里暴露它**，放在已经带 `updates`、`shortcuts` 的那个
   `exposeInMainWorld("dshDesktop", …)` 对象里：

   ```js
   restart: () => electron.ipcRenderer.invoke(DESKTOP_IPC.restart),
   ```

## 插件会怎么用它

dsh-plugin-restart 会在「正常退出」模式下调用 `window.dshDesktop.restart()`，而把自己那套收尾只留作
**老版本壳的回退**（和它对其它能力做探测的方式一致）。用户能看到的差别是：
**「插件把应用杀了、又起一个」 vs 「应用自己退出，然后回来」**——后者才是人们说「重启」时的意思。

## 代价

运行时没有额外开销：启动阶段不做新事情，只多一个 IPC handler，而它调用的路径
（`quitWithoutConfirmation` + `app.relaunch`）本来就从托盘菜单在跑。同源校验用的是 `directoryPick`
已有的那套，所以 Desktop 文档之外的页面够不到它。
