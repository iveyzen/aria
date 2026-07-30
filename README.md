# Aria — 会看屏幕、会说话的桌面陪伴 AI

Aria 是一个 Windows 桌面陪伴 AI：爱玩游戏、懂二次元的女生。她通过
OpenAI **gpt-realtime-2.1**（Realtime API，语音+图像输入 → 语音输出）实时和你语音聊天，
并且会定期"看"你的屏幕截图，知道你在玩什么游戏、在做什么。

## 功能

- 🎙 **实时语音对话** — 服务端语义 VAD 自动断句，说话可随时打断她
- 👀 **屏幕感知** — 帧差检测，画面变化明显才发截图（省 token）；你开口提问的瞬间会自动补一张最新截图
- 💬 **主动吐槽** — 画面剧变（团灭/过关/进 Boss 战）且冷却结束时，Aria 会主动开口评论，可在设置里关闭
- 🧹 **上下文瘦身** — 会话里只保留最近 3 张截图，旧的自动删除
- 📝 实时字幕、可爱的 SVG 头像（嘴型跟着她的声音动）

## 运行要求

- Windows 10/11（屏幕捕获和音频要在 Windows 本机跑，**不能在 WSL 里跑**）
- Node.js 20+（`winget install OpenJS.NodeJS.LTS`）
- OpenAI API Key（需要有 Realtime API 权限）

## 在 Windows 上运行

本仓库如果放在 WSL 里，先把它复制到 Windows 侧（node_modules 不用复制）：

```powershell
robocopy \\wsl.localhost\Debian\home\zengp\code\aria D:\aria /E /XD node_modules dist
cd D:\aria
npm install
npm start
```

启动后点右上角 ⚙ 填入 API Key（也可以设置环境变量 `OPENAI_API_KEY`），然后点**连接**。

## 使用提示

- **游戏请用无边框窗口化 / 窗口化**：独占全屏（Exclusive Fullscreen）下 Windows 桌面捕获拿不到画面
- 麦克风建议用耳机，回声消除已开启但外放大音量时仍可能误触发打断
- 费用参考（gpt-realtime-2.1）：音频输入 $32/1M、音频输出 $64/1M、图像输入 $5/1M token；
  默认设置下截图频率已经压得比较低，长时间挂机注意用量
- 配置文件位置：`%APPDATA%/aria/aria-config.json`

## 目录结构

```
src/main/        主进程（TypeScript）
  main.ts        窗口 + IPC + 截图调度
  realtime.ts    gpt-realtime-2.1 WebSocket 客户端
  screen.ts      desktopCapturer 截屏 + 帧差检测
  persona.ts     Aria 人设 prompt
  config.ts      配置读写
src/preload.ts   contextBridge API
renderer/        渲染进程（原生 JS，无构建）
  renderer.js    UI + 麦克风/播放音频管线
  worklets/      AudioWorklet（采集 / 流式播放）
```

## Roadmap

- [ ] Live2D / VRM 立绘桌宠模式（透明置顶小窗）
- [ ] 长期记忆（记住你常玩的游戏和喜好）
- [ ] 唤醒词 & 托盘常驻
- [ ] 会话过长时自动摘要重连
