# SwitchScreen — 跨平台软件 KVM

两台电脑（Mac / Windows 任意组合）共用**一个显示器 + 一套物理键鼠**，提供 3 大功能：

1. **切换电脑**：自定义快捷键，一键把显示器 + 键鼠控制权切到另一台。
2. **剪贴板同步**：在任意一台复制，另一台可直接粘贴（可开关）。
3. **共用键鼠**：主机捕获物理键鼠输入并转发到对端注入；可随时选择「共用」或「各自用各自的」。

---

## 工作原理（单显示器模型）

```
        ┌──────────────┐        DDC/CI        ┌─────────────────┐
   PC-A │ 主机(接键鼠) │ ─── 切输入源 ───────▶ │                 │
   (Win)│ iohook捕获   │ ─── WS 转发键鼠 ───▶  │   显示器 HDMI1  │
        │ robotjs注入  │ ◀── WS 回传剪贴板 ──  │                 │
        └──────────────┘                      │   HDMI2 ← PC-B  │
        ┌──────────────┐                      └─────────────────┘
   PC-B │ 客户端       │
   (Mac)│ robotjs注入  │
        └──────────────┘
```

- **主机（host）**：接了物理键鼠的那台，负责 `iohook` 捕获输入。
- **客户端（client）**：接收转发来的输入并用 `robotjs` 注入。
- **切换**：快捷键触发 → 用 DDC/CI 把显示器切到目标机的输入口 → 主机转发目标改为该机。
- **共用键鼠开关关掉时**：主机不再捕获/转发，各自用各自本机的键鼠（此时显示哪台由显示器决定）。

> 如果你其实是「多显示器、鼠标滑过屏幕边缘接管另一台」（Synergy 模型），把 `isHost` 两边都设为 true 并把输入按屏幕边界转发即可，传输层不变。本 MVP 先实现更常见的单显示器 KVM 模型。

---

## 操作界面（GUI）

启动后是一个常驻托盘的主窗口，三个标签页对应三大功能：

| 标签 | 内容 |
|------|------|
| **切换电脑** | 双机工作台示意（本机 ↔ 另一台）、显示器检测与选择、对端所在接口（HDMI1/HDMI2/DP…）、全局快捷键开关与按键、登录时启动、大号「切换到 …」按钮，底部实时显示「设置已保存 / 已发送切换指令」 |
| **复制粘贴** | 同步总开关、配对状态条（已连接 / 等待配对）、6 位连接密码与随机生成、接收目录（选择 / 打开 / 恢复默认）、传输进度条与「保存并连接 / 取消传输 / 使用最近接收」 |
| **共用键鼠** | 三种模式（各用各的 / 共用本机键鼠 / 共用对端键鼠）、辅助功能授权状态与跳转按钮、当前画面指示、显示器选择、鼠标发送速度 0.5~2 倍滑杆 |

实现位置：`electron/main.js`（窗口 + 托盘 + IPC）、`electron/preload.js`（安全桥）、`electron/services.js`（状态聚合与系统能力）、`electron/renderer/`（HTML/CSS/JS 界面）。

界面上的开关都是**即时生效**的：配置写回 `~/.switchscreen/config.json`，`peer` 持有同一配置引用，不需要重启。

---

## 安装（每台机器都要装）

```bash
npm install        # 会编译 iohook / robotjs 原生模块，需要对应平台编译工具链
```

- Windows：需安装 [Windows Build Tools](https://github.com/Microsoft/nodejs-guidance)（`npm install --global windows-build-tools` 或 Visual Studio 生成工具 + Python）。
- macOS：需 Xcode Command Line Tools；首次运行要在「系统设置 → 隐私与安全性 → 辅助功能 / 输入监控」里授权终端/Node。
- Linux：需 `libudev`、`libx11`、`libxtst` 等开发包；DDC 用 `ddcutil`。

> 注意：`iohook` / `robotjs` 是原生模块，**必须在目标机器上本地编译**，本仓库不包含预编译二进制。

---

## 配置

配置文件位于 `~/.switchscreen/config.json`（`src/config.js` 负责读写，首次运行生成默认值）。

关键字段：

| 字段 | 说明 |
|------|------|
| `peerName` | 本机名字（用于发现和去重） |
| `port` | WebSocket 控制端口 |
| `shareInput` | 共用键鼠总开关（false=各自用各自的） |
| `clipboardSync` | 剪贴板同步开关 |
| `switchHotkey` | 切换快捷键，`{keycode, ctrl, alt, shift, meta}` |
| `isHost` | 本机是否接了物理键鼠（捕获端） |
| `monitor.command` | 按平台填写的 DDC 切换命令模板，含 `{input}` 占位 |
| `peers[<名字>].input` | 该对端对应的显示器输入源值（如 `0x11`） |

设置快捷键（交互录制）：

```bash
npm run record-hotkey
```

---

## 运行

两台机器都执行：

```bash
npm start
```

启动后会：
1. UDP 广播发现局域网内的另一台；
2. 自动建立 WebSocket 链路（按名字字典序只建一条，避免双向重复）；
3. 开始剪贴板轮询同步；
4. 监听切换快捷键；主机在 `shareInput` 开启时捕获并转发键鼠。

---

## 当前状态 / 待实测项

- ✅ 传输与发现、剪贴板同步、快捷键匹配、状态机：纯 JS，逻辑完整。
- ⚠️ 键鼠注入映射表（`src/input.js` 的 `IOHOOK_TO_ROBOT`）：覆盖常用键，特殊键需在真机校准。
- ⚠️ 显示器 DDC 命令：需按你显示器的实际输入口填写 `monitor.command`（工具推荐 `ddcutil` / `ddcctl` / Windows 版 `ddcutil`）。
- ⚠️ 鼠标坐标为绝对坐标转发，两台分辨率不一致时可能需要改增量转发（代码已留接口）。

---

## 打包成安装包（.exe / .dmg）

用 electron-builder 打包成带系统托盘的真实安装包。由于 `iohook`/`robotjs` 是停止维护的
原生模块（没有 Node20/arm64 的预编译），构建时必须**从源码编译**——仓库已用
`.github/workflows/build.yml`（GitHub Actions）把整套工具链固化好，**推到 `main` 即自动出双包**。

### 双平台一键出包（推荐，已验证通过 ✅）

只要把代码推到 `main`，GitHub Actions 会：
- 在 **Windows runner** 编译出 `SwitchScreen Setup *.exe`（NSIS，约 75 MB）；
- 在 **macOS runner** 编译出 `SwitchScreen *.dmg`（约 92 MB）；
- 两个产物作为 **Artifact** 附在 Actions 运行页面，可直接下载（私有仓库仅协作者可见，默认 90 天过期）。

```bash
git push origin main        # 推送即触发 CI，去 Actions 页面下载 exe / dmg
```

最新一次成功构建：
https://github.com/muzi86754781/switchscreen/actions/runs/40280911541

> 构建要点（已固化在 CI，无需你管）：`--ignore-scripts` 装依赖 → 手动拉 Electron 二进制 →
> `@electron/rebuild --force` 从源码编译 iohook/robotjs → 有效 512×512 图标 → `--publish=never`
> 仅产出 Artifact（不发布 Release）。Windows runner 用 `windows-2022`+`ilammy/msvc-dev-cmd`，
> 两平台都补 `setuptools<81`（node-gyp 需要 distutils）。

### 在本机自己打包（可选）

```bash
npm install --ignore-scripts
node node_modules/electron/install.js
npx @electron/rebuild --force     # 需本机有 MSVC(X64) / Xcode CLT + Python3(setuptools<81)
npm run dist:win                  # Windows 安装包
# 或 macOS 上：
npm run dist:mac                  # macOS dmg（CSC_IDENTITY_AUTO_DISCOVERY=false 关闭自动签名）
```

打包后 `main` 指向 `electron/main.js`：启动即常驻系统托盘，菜单里可实时开关
「共用键鼠 / 剪贴板同步」、一键切换电脑、退出。安装时会请求辅助功能/输入监控权限（macOS）
或运行安装的程序（iohook 需要），按提示授权即可。

### 未签名安装包的注意事项（当前状态）

- **Windows (.exe)**：无代码签名，SmartScreen 会报“Windows 已保护你的电脑”。
  点「更多信息 → 仍要运行」即可；或右键 exe → 属性 → 解除锁定。
- **macOS (.dmg)**：无 Apple 开发者签名，Gatekeeper 会拦截。
  右键 dmg → 打开；或终端 `xattr -cr SwitchScreen-*.dmg` 后双击；或系统设置 → 隐私与安全性 → 仍要打开。
- 若要消除告警，需购买代码签名证书（Windows：~$100/年；macOS：Apple Developer $99/年）并接入 notarization，
  后续可加进 CI（设 `CSC_LINK` / `CSC_KEY_PASSWORD` 等密钥）。

---

## 目录结构

```
src/
  config.js     # 配置读写（含 UI 配置段）
  net.js        # UDP 发现 + WebSocket 传输（携带平台标识）
  clipboard.js  # 剪贴板跨机同步（CJS/ESM 双兼容）
  monitor.js    # DDC/CI 切输入源（命令行兜底）
  input.js      # iohook 捕获 / robotjs 注入
  peer.js       # 编排：状态机 + 串联各模块（支持动态启停捕获）
  cli.js        # 无界面入口：start / record-hotkey / config
electron/
  main.js       # 主进程：窗口、托盘、全局快捷键、IPC
  services.js   # 状态聚合、显示器检测、DDC 切换、权限、登录启动
  preload.js    # contextBridge 安全 API
  renderer/     # index.html + style.css + app.js（三标签界面）
```

---

## macOS 兼容性

- **构建目标**：`minimumSystemVersion = 11.0`（Big Sur）及以上；**macOS 13 Ventura（含 13.7.8）已覆盖**。
- **双架构**：CI 分别产出 `switchscreen-mac-x64`（Intel）与 `switchscreen-mac-arm64`（Apple Silicon）。
  在 Mac 上 `uname -m` 看是 `x86_64` 还是 `arm64`，下载对应包即可（下载错架构会提示「应用已损坏/无法打开」）。
- **权限**：首次使用「共用键鼠」需在「系统设置 → 隐私与安全性 → 辅助功能」里勾选 SwitchScreen，
  否则 `robotjs` 无法注入、`iohook` 无法捕获；界面「共用键鼠」页有「打开辅助功能设置」按钮直达。
- **DDC 切换**：**无需你安装任何工具**。Windows 直接调用系统自带 `dxva2.dll`；macOS 安装包里已内置
  `m1ddc`（Apple Silicon）或 `ddcctl`（Intel）。详见下一节。
- **睡眠唤醒**：合盖/休眠后 WebSocket 会断开，唤醒后由 UDP 广播自动重新配对（数秒内）。

---

## 显示切换（DDC/CI）怎么工作

| 平台 | 实现方式 | 依赖 |
|------|----------|------|
| Windows | 内置 PowerShell + 内嵌 C# P/Invoke 调用 `dxva2.dll`（`EnumDisplayMonitors` → `GetPhysicalMonitorsFromHMONITOR` → `SetVCPFeature(0x60, value)`） | 无（系统自带） |
| macOS Apple Silicon | 随包内置 `m1ddc`（CI 从源码编译，放在 `Resources/tools/`） | 无 |
| macOS Intel | 随包内置 `ddcctl`（CI 交叉编译 x86_64） | 无 |

- 兜底顺序：内置实现 → 随包工具 → PATH 里的 `m1ddc`/`ddcctl`/`ddcutil`/`ControlMyMonitor`。
- **重要**：DDC 指令只能由「显示器当前正在显示的那台机器」发出。所以切换回本机时，
  软件会通过 WebSocket 把 `ddc` 请求转给对端，让对端去切 —— 这样两个方向都能切。
- 若显示器 OSD 里关闭了 DDC/CI，写入会被拒绝（Windows 返回错误码 31），界面会明确提示
  「显示器拒绝了 DDC 指令（请在显示器菜单里开启 DDC/CI）」。
- 界面「连接与目标」卡片下方会显示 `当前输入：HDMI1 · DDC 可用`，可据此判断链路是否正常。
