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

---

## 附：另一个独立的、很小的请求 —— 托盘右键菜单里加一个「重启」

这一条和上面的插件 API 无关，是**壳自己的 UI**，所以单独列出；但它解决的是同一件事的用户体验。

### 现状（Electron 44，`@deepseek-ai/dsh-desktop` 0.2.0-rc.2）

托盘右键菜单里**只有两项**，定义在 `lib/main.js:10853-10867` 的 `DesktopTray.relabel()`：

```js
tray.setContextMenu(Menu.buildFromTemplate([
  { label: messages.openApplication, click: () => { this.options.open(); } },
  { type: "separator" },
  { label: messages.quitApplication, click: () => { this.options.quit(); } }
]));
```

**「重启」在壳里其实已经写好了，只是被挡在开发构建后面**：`lib/main.js:11899-11913` 的应用菜单项

```js
...development ? [
  { type: "separator" },
  { label: currentDesktopLocale().messages.reloadPageMenu, role: "reload" },
  {
    label: currentDesktopLocale().messages.restartAppHostMenu,
    click: () => { if (quitting) return; app.relaunch(); quitWithoutConfirmation(); }
  }
] : [],
```

也就是说：**正式构建里连应用菜单都没有这一项**，而托盘里从来没有过。

### 为什么插件做不到

托盘在壳的主进程里（`new Tray`、`setContextMenu`）。插件跑在两个地方：宿主机（纯 Node，没有 Electron API）和页面渲染进程（preload 只暴露固定的 `dshDesktop`：`browser`、`deviceInfo`、`shortcuts`、`updates`、`closeWindow`——**没有 Tray，也没有菜单**）。所以插件无法向托盘菜单添加任何一项。

### 建议的改法（三处，都在 `lib/main.js`）

1. **托盘菜单加一项**（`10853-10867` 的模板里，放在分隔线之前）：

```js
  {
    label: messages.restartApplication,
    click: () => {
      this.options.restart();
    }
  },
```

2. **给托盘的构造参数加上 restart**（`11939-11948`）：

```js
  restart: () => {
    if (quitting) return;
    app.relaunch();
    quitWithoutConfirmation();
  },
```

   用的是应用菜单里那段**完全一样**的代码（`app.relaunch()` + `quitWithoutConfirmation()`），并且同样先判 `quitting`，避免重复触发。

3. **文案**：本地化里已经有 `restartApplication`（`lib/main.js:6584` 一带的英文表、以及中文表）。若希望托盘里更明确，也可以用已有的 `restartAppHostMenu`（`Restart App and Host` / `重启应用与 Host`）。

### 为什么这条值得做（除了方便）

它带来的是**真正干净的退出**：走 `app.quit()` 而不是被强杀，于是 **Electron 会自己移除托盘图标**——正是用户反复问过的「为什么重启的时候托盘里的图标还在」。插件现在只能结束壳的进程，Windows 会留下一个幽灵图标直到鼠标划过；这条路没有这个问题。
