# 03 源代码与部署材料

本目录对应参赛材料清单中的“源代码与部署材料”。源代码本体位于项目根目录（并同时发布在 GitHub 仓库，见第 8 节）；此处提供提交清单、运行入口、环境变量、数据初始化、测试命令、打包规则与桌面/安卓交付说明。

## 1. 运行环境

| 组件 | 要求 |
|---|---|
| Node.js | 24+（服务端使用内置 `node:sqlite`，无 npm 运行时依赖） |
| npm | 仅用于开发期测试脚本（Playwright）与打包 |
| 浏览器 | Edge 或 Chrome；竖屏演示约 390×844 视口 |
| AI | OpenAI 兼容接口（默认硅基流动免费模型；访客可在设置中换自定义网关） |
| TTS（可选） | Qwen3-TTS 0.6B 本地服务，默认 127.0.0.1:7861 |

## 2. 安装与启动

```powershell
cd "参赛方案_资金安全管家"
npm install
npm run db:check
npm start
```

启动地址：

```text
Web       http://localhost:4173
健康检查  http://localhost:4173/api/health
金融档案  http://localhost:4173/api/finance/summary
Agent     http://localhost:4173/api/agent
TTS       http://localhost:4173/api/tts/health
```

`npm start` 会复用或启动免费模型网关，并自动探测/拉起 `scripts/start-qwen-tts.cmd`。如需单独启动 TTS：

```powershell
scripts\start-qwen-tts.cmd
```

关闭 TTS 自动拉起：

```powershell
$env:QWEN_TTS_AUTOSTART="0"
npm start
```

## 3. 数据初始化与重置

```powershell
npm run db:seed
npm run db:check
```

数据库包含众微银行主账户、银行卡、信用卡、微信绑定对象、贷款账户、理财产品、固定订阅和 200 条三个月逐笔流水。备用金是储蓄目标，不作为可支付账户余额。

## 4. 核心源代码清单

| 路径 | 作用 |
|---|---|
| `index.html` | Web/竖屏银行界面、六大功能页、Agent 对话、快捷服务、计划卡与语音交互 |
| `server.mjs` | HTTP 服务、Agent 编排、策略与动作执行、API、Webhook/企业微信入口、访客隔离 |
| `db.mjs` | SQLite schema、账户、流水、订阅、贷款、理财、票据、审计链与访客工作区 |
| `channels/im.mjs` | 企业微信回调验签、AES 解密与出站适配 |
| `data/finance.sqlite` | 可运行的生成演示档案（模拟数据） |
| `scripts/seed-db.mjs` | 数据种子和重置 |
| `scripts/check.mjs` | 静态结构、关键文案和接口契约检查 |
| `scripts/smoke.mjs` | 浏览器端到端冒烟（Edge headless，329 条断言） |
| `scripts/im-check.mjs` | IM 通道验收（Webhook/企业微信/票据/幂等，55 条） |
| `scripts/visitor-check.mjs` | 访客隔离、容量淘汰与审计保留（25 条） |
| `scripts/start-with-free-model.mjs` | 免费模型网关与 Web 服务启动编排 |
| `scripts/start-qwen-tts.cmd` | Qwen3-TTS 0.6B 服务启动器 |
| `scripts/qwen-tts-server.py` | OpenAI 兼容 Qwen TTS HTTP 服务 |
| `scripts/package-submission.mjs` | 生成提交包（排除构建产物与密钥） |
| `packaging/` | Electron 双版本 EXE 与 Android APK 打包配置 |
| `ARCHITECTURE.md` | 架构、权限模型、验收矩阵与演示剧本索引 |
| `DEPLOY.md` | 发布方式（隧道/Docker/云主机）与环境变量清单 |
| `README.md` | 项目总说明、入口、语音、渠道和演示流程 |

## 5. 验证命令

```powershell
node --check server.mjs
node --check db.mjs
npm run db:check
npm run check
npm run smoke
npm run im:check
npm run visitor:check
```

当前基线：check 通过、smoke 329/329、im:check 55/55、visitor:check 25/25、db:check 通过。`npm run check` 的接口链路检查需要服务已启动；先 `npm start` 再运行完整检查。`npm run smoke` 会自行拉起临时服务与 Edge。

## 6. IM 接入边界

通用 Webhook 与企业微信回调已实装并通过验收：HMAC-SHA256 签名 + 300s 时间窗 + 32KB 上限 + messageId 幂等（Webhook）；SHA-1 验签 + AES-256-CBC 解密 + Token 缓存 + 异步回执（企业微信）。IM 适配器只负责验签、解析、会话映射、幂等和回复格式；Agent 仍通过统一计划和服务端权限策略执行，支付密码只出现在 Web/App 确认页。契约细节见 `参赛材料/01-技术文档/` 与根目录 `REQUIREMENTS_1_3_IM_TECHNICAL_DRAFT.md`。

## 7. 提交包规则

运行：

```powershell
node scripts/package-submission.mjs
```

脚本生成 `submission-output/zhongan-bank-agent-*.zip`，包含源码、SQLite 演示数据、README、技术文档 PDF 与安全自评报告（`output/pdf/`）、部署与打包配置、测试脚本；排除 `.git`、`node_modules`、本地模型权重、EXE/APK 构建产物（`dist/`、`packaging/*/node-runtime`、Gradle 构建目录）、日志、截图和本机密钥（`data/ai-config.local.json`、`local.properties`）。模型权重不放入提交包。

## 8. GitHub 仓库

源代码与部署材料同步发布在 GitHub，供评委在线浏览：

> 仓库地址：<https://github.com/WHYLH/zhongan-agent>

仓库内容与提交包一致，并额外提供提交历史。仓库中同样不包含任何密钥、模型权重、构建产物与服务器地址。

## 9. 桌面与安卓交付（演示辅助）

`dist/` 目录提供三件可执行交付物（不进入提交包与仓库，演示时直接使用）：

| 文件 | 说明 |
|---|---|
| `dist/exe/ZhonganAgent-Offline-1.0.0.exe` | 离线本地版：自带 Node 运行时与演示数据，断网可用 |
| `dist/exe/ZhonganAgent-Online-1.0.0.exe` | 网页导向版：打开即连公网正式站点 |
| `dist/apk/ZhonganAgent-Online-1.0.0.apk` | Android 7.0+ WebView 客户端 |

重新打包：EXE 见 `packaging/electron/`（`npm exec electron-builder --win portable --x64 --config electron-builder.offline.json`），APK 见 `packaging/android/`。
