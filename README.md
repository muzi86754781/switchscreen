# SwitchScreen — 跨平台局域网轻量软件 KVM

<p align="center">
  <img src="electron/renderer/assets/icon.png" alt="SwitchScreen Logo" width="128" height="128">
</p>

<p align="center">
  <b>纯局域网轻量跨平台软件 KVM：键鼠无缝流转共用 · 硬件级 DDC/CI 多显示器独立/统一切换 · 极速剪贴板实时同步 · P2P 局域网大文件传输 · 手机扫码免 App 快传</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue?style=flat-square" alt="Platform">
  <img src="https://img.shields.io/badge/Node-18%2B-green?style=flat-square" alt="Node Version">
  <img src="https://img.shields.io/badge/Electron-31%2B-informational?style=flat-square" alt="Electron Version">
  <img src="https://img.shields.io/badge/License-MIT-orange?style=flat-square" alt="License">
</p>

---

## 📖 简介 (Introduction)

**SwitchScreen** 是一套专为多电脑协作（MacBook、Windows 台式机、工控机等任意组合）打造的**纯局域网轻量软件 KVM 解决方案**。

彻底摆脱昂贵、笨重、受限于接口带宽且容易黑屏死机的物理 KVM 切换器：只需在局域网多台电脑中运行 SwitchScreen，即可实现**一套物理键鼠掌控多台电脑、一键利用显示器原生硬件 DDC/CI 协议切换视频输入源、毫秒级剪贴板双向同步、局域网极速文件互传**，更支持**手机端无需安装任何 App 扫码即传**。

---

## 🏛️ 工作架构图 (Architecture)

```
                     ┌──────────────────────────────────────────────┐
                     │          局域网 WebSocket P2P 控制网络         │
                     └──────┬────────────────────────────────┬──────┘
                            │                                │
            ┌───────────────▼──────────────┐  ┌──────────────▼──────────────┐
            │   PC-A (Windows 11 / 10)     │  │   PC-B (macOS Apple Silicon) │
            │  · libuiohook 全局键鼠捕获    │  │  · robotjs 拟真输入注入      │
            │  · DXVA2 原生并发 DDC 引擎    │  │  · m1ddc / BetterDisplay    │
            │  · 剪贴板实时监听 / 同步器   │  │  · 剪贴板实时监听 / 同步器  │
            └───────────────┬──────────────┘  └──────────────┬──────────────┘
                            │                                │
             HDMI1 / DP 视频线 (DDC/CI)       HDMI2 / Type-C 视频线 (DDC/CI)
                            │                                │
                            └───────────────┬────────────────┘
                                            │
                                 ┌──────────▼──────────┐
                                 │   多口外接显示器    │
                                 │ (DELL / LG / ASUS)  │
                                 └─────────────────────┘
                                            ▲
                                            │ Wi-Fi 局域网免 App 扫码
                                 ┌──────────┴──────────┐
                                 │  iPhone / Android   │
                                 │  Web 快传 (无需客户端)│
                                 └─────────────────────┘
```

---

## ✨ 核心特性全景 (Key Features)

### 1. 🖥️ 硬件级 DDC/CI 视频输入源智能切换
- **无需物理 KVM 硬件**：直接利用视频线缆内置的 I2C 总线向显示器发送 VCP 0x60 指令，切换速度快、零额外线缆杂乱。
- **Windows 原生 DXVA2 引擎**：内置高性能 C# 运行时与 Win32 DXVA2 底层 API，支持多台物理显示器**多线程并发快速下发**，彻底解决单屏切走后其余屏幕设备句柄丢失失效问题。
- **macOS 全架构自愈支持**：原生集成 `m1ddc` 驱动，同时智能检测并融合 `BetterDisplay`、`Lunar` 与 `ddcctl`，支持自动硬件电源唤醒与容灾重试。
- **单屏独立切 / 全部一键切**：
  - 点击对应电脑的「全部切到这台」（或按下全局快捷键），所有外接屏统一切换。
  - 点击单块显示器图标，仅将该显示器切至目标机器，实现真正的灵活跨屏搭配。
- **跨平台硬件指纹对齐**：智能提取并持久化显示器唯一 EDID 序列号（如 `sn:gn64v6cg08tl`）与硬件模型（如 `DELL U2414H`），彻底告别 Windows 端通用占位名（`Generic PnP Monitor`）导致的错配串配。
- **独家「双向协同切换」闭环**：
  - 许多主流显示器（如 DELL U2414H、S2316M 等）在非活动端口模式下（例如当前屏幕正在显示 Mac 的 HDMI2，PC 连在 HDMI1）会自动关闭或休眠非活动物理口的 DDC 通信，导致从非活动端盲切必然失败。
  - SwitchScreen 独创双向协同机制：由当前**正点亮该显示器的活动端电脑**作为指令协调方协同下发切换命令，两端呼应，杜绝“切过去就切不回来”的行业顽疾。

### 2. ⌨️🖱️ 跨平台键鼠无缝流转与共用
- **灵活的键鼠模式**：
  - **各用各的模式**：两台电脑各自使用自带物理键鼠，仅同步显示器与剪贴板。
  - **共用键鼠模式**：任意指定一台电脑为主控端（将鼠标键盘插在此电脑上），无感控制局域网内任意客户端。
- **快捷键秒级交接控制权**：默认支持 `Alt + Q`（可自由录制自定义热键）快速切换键鼠焦点，不黑屏、零卡顿、无误触。
- **屏幕居中毛玻璃 OSD 浮动胶囊**：切换控制权时，屏幕正中央弹出优雅的半透明毛玻璃提示胶囊，实时明确当前受控电脑。
- **智能修饰键语义映射**：智能适配 Mac 的 `⌘ Command` 与 Windows 的 `Ctrl` / `Alt`，支持多种映射策略，还原原生敲击习惯。

### 3. 📋 剪贴板跨端毫秒级实时同步
- 纯局域网 WebSocket 极速同步，复制即分发。
- 支持纯文本与格式化文本无感知互通，两台电脑犹如一台。
- 可随时在设置中一键开启或静默关闭。

### 4. 🚀 局域网 P2P 点对点极速大文件传输
- **纯内网直连流式传输**：跑满局域网千兆/万兆带宽，不受任何外网网盘限制。
- **传输进度与耗时呈现**：实时显示当前传输进度百分比、动态速率与已完成耗时。
- **大文件安全防呆确认**：单次传输超过 1GB 文件自动弹窗提醒二次确认，亦可开启「免确认自动接收」。
- **便捷的文件管理与历史记录**：
  - 文件类记录点击即可直接在系统资源管理器 / Finder 中高亮选中该文件。
  - 文本类记录点击即可展开查看全文并一键复制内容。
  - 支持单条删除与一键清空已结束的历史记录。

### 5. 📱 手机端免 App 扫码网页快传
- **零安装门槛**：iPhone、iPad、Android 手机无需下载安装任何 App，同一 Wi-Fi 下使用手机相机扫码即可直接打开快传页面。
- **视网膜触控原生 UI**：针对移动端屏幕专门定制响应式界面与大触控热区。
- **原图 / 4K 视频免压缩直传**：手机相册中的照片原图、高清视频无损秒传至电脑下载目录。
- **手机端流畅预览**：电脑端发送的视频、图片在手机浏览器内支持全屏沉浸式流畅播放预览，并可一键下载保存至手机相册或本地文件。
- **电脑 ⇄ 手机双向拖拽**：电脑端直接将文件拖入网页即可推送到手机。

### 6. 🧭 设备与多显示器可视化智能排布
- **真实物理坐标感知**：自动读取操作系统原生多屏布局，按真实物理相对位置（左、右、上、下）与物理分辨率等比例渲染排布图。
- **笔记本内建屏智能区分**：自动识别 MacBook 等内置屏幕与外接显示器，内建屏不参与物理视频口切换，外接屏各司其职。
- **离线设备智能感知与一键移除**：
  - 局域网设备断开或关机后自动标记为离线，历史端口配置与屏幕记忆永不丢失。
  - 支持在界面中对已离线的过期设备执行**一键清理移除**，自动同步清退无效映射。

---

## 🚀 快速开始与安装 (Getting Started)

### 方式一：下载预编译安装包（推荐）
前往 GitHub [Releases](https://github.com/muzi86754781/switchscreen/releases) 页面下载适合您系统的最新版本安装包：
- **Windows**: `SwitchScreen.Setup.x.x.x.exe`（直接双击安装，支持开机自启与托盘常驻）
- **macOS (Apple Silicon M系列芯片)**: `SwitchScreen-x.x.x-arm64.dmg`
- **macOS (Intel芯片 / 通用)**: `SwitchScreen-x.x.x.dmg`

> **macOS 首次运行注意事项**：
> 1. 打开应用后，请进入系统「系统设置 → 隐私与安全性」：
>    - **辅助功能 (Accessibility)**：授予 SwitchScreen 权限（用于全局快捷键与键鼠控制）。
>    - **输入监控 (Input Monitoring)**：授予 SwitchScreen 权限。
> 2. 若选择开机登录自启，macOS 端启动时将自动保持静默托盘常驻，不会无故弹出主窗口打扰工作。

---

### 方式二：从源码运行

#### 环境要求
- Node.js >= 18.0.0
- npm >= 9.0.0

```bash
# 1. 克隆代码仓库
git clone https://github.com/muzi86754781/switchscreen.git
cd switchscreen

# 2. 安装项目依赖
npm install

# 3. 启动应用
npm start
```

---

## ⌨️ 全局快捷键指南 (Hotkeys Guide)

所有快捷键均可在界面「切换电脑」标签页或「共用键鼠」标签页中实时自定义录制，修改即刻生效：

| 功能 | 默认快捷键 | 说明 |
| :--- | :--- | :--- |
| **全局切屏 (全部切到下一台)** | `F11` (或 `F12`) | 将所有参与协作的外接显示器快速切换到下一个在线设备 |
| **输入源快速循环 (单机循环)** | `Alt + \`` | 在当前显示器的所有可用信号输入源间循环遍历 |
| **显示器 A 独立切换** | `Ctrl/⌘ + Alt + 1` | 独立切换系统排列最左侧的显示器 A |
| **显示器 B 独立切换** | `Ctrl/⌘ + Alt + 2` | 独立切换第二块显示器 B |
| **键鼠控制权交接 (共用模式)** | `Alt + Q` | 仅流转键鼠控制焦点至下一台设备，屏幕不黑屏，居中弹出 OSD 提示 |

---

## 🔧 硬件兼容性与配置建议 (FAQ & Compatibility)

### Q1: 为什么按切屏键后显示器没有反应？
1. **显示器菜单开启 DDC/CI**：请按下显示器机身上的物理按键呼出 OSD 菜单，找到「其他设置 / 菜单设置 / 系统」，确保 **DDC/CI** 功能已处于 **开启 (On / Enable)** 状态。
2. **转接头与扩展坞支持**：极少数廉价的 USB/Type-C 转 VGA 扩展坞内部没有连接 I2C 数据针脚，会导致 DDC 命令无法送达显示器。建议优先选用支持完整 DisplayPort Alt Mode 的 Type-C 转 DP / HDMI 线缆或正规雷电扩展坞。

### Q2: 为什么从 Mac 切回 Windows 时，DELL 等显示器有时无法切回？
- 这是由于 DELL、LG 等部分品牌显示器的节能机制：当显示器当前正在显示 Mac 画面（例如 HDMI2）时，其未点亮的物理端口（如接在 Windows 上的 HDMI1）的 I2C 接收芯片会进入彻底休眠。
- **SwitchScreen 的解决方案**：本软件内置了全自动**双向协同切换逻辑**。当从某端触发切屏时，正处于点亮状态的那台机器会通过局域网协同向该显示器下发切换指令。
- **MacBook 接线建议**：Apple Silicon MacBook（M1/M2/M3/M4 Pro/Max）机身自带的原生 HDMI 接口受 Apple 官方 GPU 固件驱动限制，无法直接对外发送标准 DDC 输入源切换指令。若您的显示器接在 Mac 自带 HDMI 口上，建议使用 **Type-C 转 DP / HDMI 线缆** 连接 Mac，或在 Mac 上安装开源辅助工具 **BetterDisplay**（SwitchScreen 已全自动兼容并能无缝调用 BetterDisplay 接口驱动原生 HDMI 端口）。

---

## 🛠️ 打包编译 (Building from Source)

SwitchScreen 使用 GitHub Actions 实现了全自动矩阵多平台编译（推送到 `main` 分支即可自动生成并发布 Releases）：

```bash
# Windows 平台打包构建 Setup 安装包
npm run dist:win

# macOS 平台打包构建 DMG 镜像
npm run dist:mac
```

---

## 📄 开源许可证 (License)

本项目基于 [MIT License](LICENSE) 开源。欢迎提交 Pull Request、Issue 或 Star 支持！
