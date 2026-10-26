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

用 electron-builder 打包成带系统托盘的真实安装包：

```bash
npm install          # 安装依赖并执行 postinstall 重建 iohook/robotjs（针对 Electron ABI）
npm run dist:win     # 产出 Windows 安装包 dist/SwitchScreen Setup *.exe (NSIS)
npm run dist:mac     # 产出 macOS 安装包 dist/SwitchScreen *.dmg（需在 Mac 上运行）
```

打包后 `main` 指向 `electron/main.js`：启动即常驻系统托盘，菜单里可实时开关
「共用键鼠 / 剪贴板同步」、一键切换电脑、退出。安装时会请求辅助功能/输入监控权限（macOS）
或运行安装的程序（iohook 需要），按提示授权即可。

> **图标**：当前 `build/icon.png` 是占位 1×1 图，发布前换成自己的 256×256+ PNG 即可。

### 双平台一键出包（推荐）

本仓库含 `.github/workflows/build.yml`：在 GitHub 打 `v*` 标签或手动触发 Actions，
会分别在 Windows / macOS  runner 上构建，产物（`.exe` 与 `.dmg`）作为 Artifact 下载。
**因为 dmg 只能在 macOS 环境生成，这台 Windows 开发机无法直接打出 dmg**，用 CI 是最省事的方式。

---

## 目录结构

```
src/
  config.js     # 配置读写
  net.js        # UDP 发现 + WebSocket 传输
  clipboard.js  # 剪贴板跨机同步
  monitor.js    # DDC/CI 切输入源
  input.js      # iohook 捕获 / robotjs 注入
  peer.js       # 编排：状态机 + 串联各模块
  cli.js        # 入口：start / record-hotkey / config
```
