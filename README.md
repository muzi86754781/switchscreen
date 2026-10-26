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

> 想看「鼠标滑过屏幕边缘就接管另一台」的 Synergy 模型？选「共用键鼠」即可，
> 软件已按屏幕边界做无缝转发（见下文「共用键鼠：无缝移动」），传输层不变。

---

## 操作界面（GUI）

启动后是一个常驻托盘的主窗口，三个标签页：

| 标签 | 内容 |
|------|------|
| **切换电脑** | 双机工作台（**一台电脑一行**：名字 + 连接状态 + 它在各块显示器上的落点，正在用的那台整行高亮并标「使用中」，行尾「切到这台」）；显示器与接口（**逐台列出所有显示器**，每台给出「切到 Windows / 切到 Mac」两个单台切换按钮，以及本机 / 对端各自的接口芯片组，不用下拉框）；全局快捷键、登录时启动；大号「一键切换全部显示器」按钮；底部实时状态 |
| **传输与剪贴板** | 剪贴板同步总开关（A 复制 B 粘贴）、连接状态条（局域网自动发现，无需配对码）、**发送到**（多台对端时可点选接收对象，默认选中第一台）、拖拽 / 选择文件或整个文件夹、发送文字、超过 1GB 发送前询问、免确认自动接收开关（默认关闭）、传输记录（进度 / 取消 / 在文件夹中显示）、接收目录 |
| **共用键鼠** | 三种模式（各用各的 / 共用本机键鼠 / 共用对端键鼠）、**无缝移动**（鼠标推到屏幕边缘即换电脑，可设另一台在左/右/上/下）、**按键兼容**（⌘ ⇄ Ctrl 三档映射 + 按键诊断）、键鼠就绪状态、当前画面与键鼠来源 |

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
| `ui.perMonitor` | 每台显示器各自的接口：`{ "ddc:0": { "local": "0x11", "remote": "0x12" } }`；为空则回退到 `ui.localInput` / `ui.remoteInput` |
| `ui.edgeSwitch` | 鼠标推到屏幕边缘自动切换（默认 `true`） |
| `ui.edgeSide` | 另一台电脑在本机的哪一侧：`right` / `left` / `top` / `bottom` |
| `ui.modMap` | 修饰键映射：`cmd-ctrl`（默认）/ `swap` / `off` |
| `ui.keyDebug` | 按键诊断：状态栏打印原始键码（默认 `false`） |
| `ui.autoAccept` | 是否免确认自动接收文件（默认 `false`，即每次弹「接收 / 取消」） |
| `ui.targetPeer` | 上次选中的接收对象名字（不在线时自动回退到第一台） |

> 局域网内靠 UDP 广播自动发现，**没有配对码/连接密码**这一步；两台在同一个网段、都打开软件即可互连。

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

- ✅ 传输与发现、剪贴板同步、快捷键匹配、状态机、无缝移动、键位映射：纯 JS，逻辑完整，已有单元测试覆盖。
- ✅ 键位映射（`src/keymap.js`）：VC 虚拟键码 + VK/ASCII 两套约定，可打印字符走 `keychar`；
  ⌘ ⇄ Ctrl 语义映射三档可选。个别按键不对时可用「按键诊断」看原始键码。
- ⚠️ 真机手感需要在你的 Mac + Windows 组合上各跑一次（鼠标速度、边界方向、修饰键映射档位）。
- ⚠️ iohook 不能拦截本机输入，共用期间按键本机也会收到（见「无缝移动」一节的已知限制）。

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
  filetransfer.js # 文件/文件夹/文本传输（分块 + 串行写盘）
  monitor.js    # DDC/CI 切输入源（命令行兜底）
  keymap.js     # 键位翻译：VC/VK 双约定 + ⌘⇄Ctrl 跨平台映射
  input.js      # 捕获（相对位移 / 边界检测）与注入（虚拟指针 / 修饰键复位）
  peer.js       # 编排：状态机 + 串联各模块（无缝穿越、中转 DDC、动态启停捕获）
  cli.js        # 无界面入口：start / record-hotkey / config
electron/
  main.js       # 主进程：窗口、托盘、全局快捷键、IPC
  services.js   # 状态聚合、显示器检测、DDC 切换、权限、登录启动
  ddc/          # 原生 DDC/CI：win-ddc.ps1（dxva2）+ index.js（统一封装）
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
- 界面「连接与目标」卡片会**直接列出所有检测到的显示器**（不使用下拉框）。每台显示器下面分两行
  「本机 / 对端」，用**接口芯片按钮**（HDMI1 / HDMI2 / DP1 / DP2 / USB-C…）点选这台显示器分别接在哪台电脑的哪个口。
  这样多显示器各接不同端口时也能精确切换（例如显示器 1 接 Windows 的 HDMI1 / Mac 的 HDMI2，
  显示器 2 只接 Windows —— 后者在对端那一行留空即可，切换时不会被错误切走）。
  - 未逐台配置时，回退到一组全局接口值，行为与以前一致（所有显示器一起切到同一个口）。
  - 当前输入源所在的芯片会带一个 `•` 标记。
- 点「切换」或按快捷键时，**所有已配置的显示器会在一次 DDC 批量里一起切**（Windows 单个 PowerShell 进程 / macOS 顺序下发），
  并在界面上显示 `已切换 / 2-2 台显示器 / 失败原因`。
- 界面「连接与目标」下方会显示 `当前输入：HDMI1 · DDC 可用`，可据此判断链路是否正常。

---

## 共用键鼠：无缝移动

选择「共用本机键鼠」（或「共用对端键鼠」）后，只要把鼠标推到屏幕的某一边，画面与键鼠控制权
就一起过去；在对端把鼠标推回来，又立刻回到本机。整个过程不需要按快捷键。

| 配置 | 说明 |
|------|------|
| `ui.edgeSwitch` | 是否开启边缘切换（默认开） |
| `ui.edgeSide` | 另一台电脑在本机的哪一侧：`right`（默认）/ `left` / `top` / `bottom` |
| `ui.modMap` | 修饰键映射：`cmd-ctrl`（默认，推荐）/ `swap` / `off` |
| `ui.mouseSpeed` | 相对位移缩放（0.5 ~ 2，默认 1） |

实现要点（`src/input.js` + `src/peer.js`）：

- **相对位移**：鼠标只发 `dx/dy`，对端自己累加成绝对坐标注入。两台分辨率、缩放不同，
  速度与手感仍然一致，不会出现「一跳半个屏幕」。
- **锚点回拉**：iohook 的 `mousemove` 只有绝对坐标，指针顶到屏幕边缘后位移会变成 0，远端指针就卡住了。
  所以转发期间把本机指针不断拉回屏幕中心，保证始终能取到真实位移。
- **幻影指针**：host 侧自己维护「对端指针在哪」的坐标，一旦越过对端屏幕的另一侧，
  就发 DDC 把画面切回来，并把本机指针放到对应的边上 —— 这就是「无缝」的来源。
- **屏幕尺寸交换**：连上后双方互发 `meta`（平台 + 屏幕尺寸），跨分辨率时按比例落位。
- **按键复位**：每次切换都广播 `input-reset`，两端释放所有按住的修饰键，避免「一直按着 ⌘」。

> 已知限制：iohook 无法拦截本机输入（它的 `start()` 参数是 keycode 模式，不是抑制）。
> 所以共用期间按键除了发给对端，本机也会收到一份。建议把本机当前应用切到一个无输入焦点的地方。

### ⌘ Command 与 Ctrl 的跨平台兼容

`src/keymap.js` 负责把捕获到的按键翻译成「目标系统上语义相同」的按键：

| 模式 | Mac → Windows | Windows → Mac |
|------|---------------|---------------|
| **⌘ ⇄ Ctrl（默认）** | ⌘ 和 ⌃ 都发成 `Ctrl` | `Ctrl` 和 `Win` 都发成 ⌘ |
| 严格互换 | ⌘ → `Ctrl`，⌃ → `Win` | `Ctrl` → ⌘，`Win` → ⌃ |
| 不映射 | 原样转发 | 原样转发 |

默认档位下 `⌘C → Ctrl+C`、`Ctrl+C → ⌘C` 都成立，这也是绝大多数人期望的行为。
两端是同一种系统时自动不做任何映射。

另外两层容错：
- **可打印字符走 `keychar`**：绕开 iohook 在不同版本/平台上「VC 虚拟键码 vs ASCII/VK 码」的差异，
  同时天然处理了键盘布局差异。
- **按键诊断开关**（`ui.keyDebug`）：打开后在状态栏打印 `keycode / keychar → token → 映射后`，
  个别键不对时把它打开按一下，就能看到到底是哪一层出的问题。

---

## 传输与剪贴板

**剪贴板**
- 打开「开启剪贴板同步」后，在任意一台复制文字 / 截图 / 图片，另一台直接粘贴。
- 关闭同步不影响发文件与发文字。

**发文件**
- 入口：「传输与剪贴板」标签页，把文件/文件夹拖进虚线框，或点「选择文件」（支持多选与整个文件夹）。
- 发送前先在「发送到」里选中接收对象（有多台对端时可点选，默认选中第一台）。
- 勾选「超过 1GB，发送前询问」时，大于 1GB 的内容会先弹确认框。

**收文件**
- 默认**每次都会先问**：「接收 / 取消」。点「取消」会立即通知发送方（对端记录显示「对方已拒绝」）。
- 勾选「免确认自动接收文件」后不再询问（默认关闭）。
- 文件落在「接收目录」，同名自动加 `(1)`，可在记录里「在文件夹中显示」。

**发文字**
- 在输入框写内容 → 点「发送文字」（或 Ctrl/⌘ + Enter）。
- 对方会**直接弹出文本内容**，并带一个「拷贝到剪贴板」按钮，一键粘到当前应用。

**协议**
- 复用同一条 WebSocket 连接：`file-offer → file-accept → file-chunk(256KB base64) → file-done`，
  拒绝走 `file-reject`，取消走 `file-cancel`；文字走 `text-send`。
- 接收端**串行写盘**（避免 `file-done` 早于最后一块落盘导致文件写串），发送整个文件夹时会还原同名目录结构。
- 发送期间每个分块之间会让出事件循环，界面刷新节流到 ~10fps，避免影响键鼠转发。

---

## 更新日志

### v0.5.0

- **双机工作台重做：一台电脑一行**
  - 每行显示电脑名 + 连接状态（局域网已连接 / 等待发现），行尾「切到这台」，正在使用的那台整行高亮并标「使用中」。
  - 行内直接画出**显示器排列**：这块屏在这台机器上走哪个接口、此刻是否正显示它（`is-here` 高亮 + 左侧竖条点亮）。
  - 顶部「一键切换全部显示器」；每块屏在「显示器与接口」里另有独立的「切到 Windows / 切到 Mac」按钮，
    可只动其中一块，互不影响。
- **去掉「01 连接配对」区域**：只在局域网使用，UDP 广播自动发现，不需要配对码。
  （旧配置里的 `usePassword` / `password` 会在启动时自动清掉。）
- **共用键鼠：无缝移动**
  - 鼠标推到屏幕边缘就换电脑，推到对端另一侧又自动回来；可选「另一台在我左/右/上/下」。
  - 鼠标改为**相对位移**转发，两台分辨率不同也一致；转发期间把本机指针拉回屏幕中心，
    解决「顶到边缘后位移变 0、远端指针卡住」。
  - host 侧维护幻影指针，越界即发 DDC 回切；连上后互发屏幕尺寸，按比例落位。
  - 每次切换广播 `input-reset`，两端释放所有按住的修饰键，不再出现「一直按着 ⌘」。
- **⌘ Command 与 Ctrl 跨平台兼容**（`src/keymap.js`）
  - 新增 `cmd-ctrl`（默认，⌘/⌃ → Ctrl，Ctrl/Win → ⌘）、`swap`（严格互换）、`off` 三档。
  - 键码解码改为「`keychar` 优先 + VC/VK 双表兜底」，绕开 iohook 不同版本的键码差异。
  - 新增「按键诊断」开关，按任意键在状态栏显示 `keycode / keychar → token → 映射后`。
- 传输页去掉密码卡片，连接状态条改为「局域网自动发现」提示。

### v0.4.0

- **合并「复制粘贴」与「文件传输」为一个标签页「传输与剪贴板」**
  - 保留配对状态条、6 位连接密码、超过 1GB 发送前询问、A 复制 B 粘贴说明。
  - 保留发送文件与发送文字；新增「发送到」接收对象选择（多对端可点选，默认选中第一台）。
  - 接收文件时弹「接收 / 取消」；拒绝会同步告知发送方。
  - 接收文字直接弹窗展示全文 + 「拷贝到剪贴板」按钮。
  - 新增「免确认自动接收文件」开关（默认关闭 = 每次手动确认）。
- **「连接与目标」改为逐台显示器 + 接口芯片按钮**（彻底去掉下拉框），支持每台显示器指向不同端口；
  Windows 新增 `setplan` 批量下发（一次 PowerShell 进程切完所有显示器，实测 2 台约 1.3s）。
- **修复切换没反应**：DDC 结果现在会等执行完成再回推界面，成功 / 失败 / 失败原因立刻可见；
  切换期间按钮置灰，避免重复触发。
- **修复 F12 无效**：全局快捷键注册失败（常被开发者工具占用）时自动回退到 F11/F10/…/⌘⇧F12，
  并把实际生效的按键回写到界面；窗口聚焦时也直接响应切换键。
- **修复两端状态不同步**：收到对端 `active` 后本地也更新「当前画面在哪台」，
  避免下一次切换由错误的机器发 DDC 指令（这是「Mac 双击 Windows 没反应」的根因）。
- **修复 macOS 辅助功能误报未授权**：改为以「键鼠捕获是否真的启动成功」为准，
  未签名应用下系统 API 常误报；已授权时不再显示跳转按钮。
- **去掉「共用键鼠」页的「显示器与鼠标速度」区域**（已无必要）。

### v0.3.0

- 新增文件/文本传输标签页（LANDrop 风格，分块传输 + 串行写盘）。
- 双机工作台按当前电脑着色标注，支持双击切换。
- 显示器改为列表展示，切换时所有显示器一起切。
- 修复 `ddcctl` 输入源必须是 1–18 十进制（原来传 `0x11` 被当成参数错误）。
