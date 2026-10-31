# DSH Free Model 接入调查与落地方案

> 调查对象：GitHub 项目 [`Ebony-Vinyl/dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)
> 目标：把它作为「众安 · 予安」的默认内置 AI，做到开箱即用。
> 调查时间：2026-10-24（仓库 HEAD `f3ecb7abcf5a0351645cfcbd638b9c7fbbcb3e97`）
> 约束：未修改 `index.html`；未删除现有功能；未写入、复制或提交任何共享/泄露 Key；未调用 DeepSeek 官方 API。
> 工作区状态：截至 23:16，`npm start` 已被并行改为 `scripts/start-with-free-model.mjs`（自带 clone，默认模型已改为 `kilo-auto/free`）。本文件第 3.3 节是对该实现的审查与加固建议，第 4 节是已实测的参考实现。

---

## 0. 结论（TL;DR）

1. **本机没有安装该 DSH 插件**：`~/.dsh/profiles/{web,desktop,acp,headless}` 均无 `dsh-our-free-model`，`~/.dsh/our-free-model` 数据目录不存在。
2. 同一仓库里的 **独立本地服务（`packages/standalone`）可以在本机零依赖直接跑起来**，提供 OpenAI 兼容的 `http://127.0.0.1:18900/v1`，启动时自动生成本机 Key。已实测：`/health` 200、`/v1/models` 27 个模型、`/v1/chat/completions` 200、工具调用 200、本项目 `/api/agent` 全链路 200。
3. **推荐落地方式**：不改 `server.mjs` 的取 Key 逻辑，新增一个启动包装脚本，由它拉起/复用 18900 网关、从本机 `settings.json` 读取 `forwardKey`、注入 `AGGREGATOR_*` 环境变量后启动本项目。Key 只存在于本机文件与进程内存，不进入仓库、前端或文档。
4. **插件形态（DSH 内置）是备选**：需要 `dsh plugin --profile web add <本地目录>`，且默认转发端口 18899 是关闭的，还要手动开启 `forward.enabled`。本机 dsh 为 `0.2.1-rc.2`，上游 README 只声明验证过 `0.1.5–0.1.7-rc.2`，插件路线存在兼容性风险，不如独立服务稳妥。
5. **当前限制**：本机出口在 OpenCode 匿名免费车道被限流（`429 Free usage limit reached`），`deepseek-v4.1-flash-free`、`glm-5.3-flash-free` 与 `combo:recommended-free` 暂时不可用；Kilo 免费池 `kilo-auto/free` 在 23:05 正常（工具调用可用），但 23:15 复测出现 `502 TRANSPORT / ECONNRESET`，说明免费车道受出口网络影响会波动。默认模型因此选 `kilo-auto/free`，并允许 `OFM_MODEL` 覆盖。
6. **并行落地版本已存在**：`scripts/start-with-free-model.mjs` 已被接入 `npm start`，默认模型在 23:13 已改为 `kilo-auto/free`（正确）。仍有 4 个需要加固的点：扫描 `%TEMP%\ofm-data` 取 Key、端口顺延后不跟随、网关退出不回收、`vendor/` 约 35 MB 且未忽略/未固定 commit。见 3.3(1)。

---

## 1. 上游项目：真实安装 / 启动命令

### 1.1 版本与来源

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/Ebony-Vinyl/dsh-our-free-model` |
| 插件版本（根 `package.json`） | `2.5.9` |
| 独立服务版本（`packages/standalone/package.json`） | `2.5.4` |
| 本次调查 commit | `f3ecb7abcf5a0351645cfcbd638b9c7fbbcb3e97`（2026-10-24） |
| 许可证 | MIT |
| Node 要求 | `^22.19.0 || >=24.0.0`（本机 v24.19.0，满足） |
| 运行依赖 | 无。独立服务**不需要 `npm install`**，本次在无 `node_modules` 的干净克隆中直接启动成功 |

### 1.2 形态 A：DSH 插件（命令行，纯 web profile）

```powershell
git clone https://github.com/Ebony-Vinyl/dsh-our-free-model.git C:\tools\dsh-our-free-model
dsh plugin --profile web add C:\tools\dsh-our-free-model
# 安装后重启一次 DSH 应用
```

验证是否进入 bundle 列表：

```powershell
dsh --profile web --dump-config | Select-String our-free-model
# 期望只出现一次 id: our-free-model（不要同时写 cordis.patch.yml，否则会报 duplicate loader entry id）
```

说明：

- `dsh plugin --profile <name> add <包>` 本机已验证语法（`dsh --help`、`dsh plugin --help`）。
- **桌面端（Electron）的 `desktop` profile 只能由桌面应用自身管理**，命令行会报 `profile "desktop" is managed exclusively by the Electron application`，需在桌面端「设置 → 插件」里安装。
- 上游 README 明确警告：**不要从 npm 安装 `dsh-our-free-model`**。npm 上的同名包是第三方改动版（`index.js`/`client.js` 被改，且含仓库从未有过的 `src/channel-visibility.js`），拿不到签名清单与应用内升级。只从本仓库 Release 或本地源码目录安装。
- AIO/旧桌面整合包可能有 profile 闸门，禁止 `link:` 依赖与 junction；此时改用本地 tarball（`npm pack --ignore-scripts`）或应用内插件管理器。
- 上游 README 徽章标注适配 `dsh 0.1.5–0.1.7-rc.2`；`peerDependencies` 允许 `^0.2.0-rc.1`。本机 `dsh 0.2.1-rc.2` **未被上游明确验证**，属于风险项。

### 1.3 形态 B：独立本地服务（本次实测采用）

```powershell
git clone https://github.com/Ebony-Vinyl/dsh-our-free-model.git C:\tools\dsh-our-free-model
cd C:\tools\dsh-our-free-model
node packages\standalone\cli.mjs --port 18900
# 或：npm run start:standalone
```

也支持指定数据目录：

```powershell
node packages\standalone\cli.mjs --port 18900 --data-dir C:\Users\whylh\.our-free-model
```

启动后终端会打印（**不打印 API Key 本身**）：

```
our-free-model-standalone 2.5.4
管理页面（10 分钟内一次性登录）：http://127.0.0.1:18900/#login=<一次性令牌>
API：http://127.0.0.1:18900/v1
API Key 保存在：C:\Users\whylh\.our-free-model\settings.json
```

要点：

- 首次启动自动生成 `forwardKey` 并写入 `<数据目录>\settings.json`；Key 在本机生成，不来自任何共享池。
- 默认数据目录 `~/.our-free-model`，可用 `OFM_HOME` 或 `--data-dir` 覆盖；**不要**把它指向 DSH 插件的数据目录（两者互不兼容）。
- 默认端口 18900；被占用时共享监听器会自动顺延，并优先沿用上次保存的端口。因此生产启动脚本应固定端口并在冲突时明确报错，而不是猜端口。
- 不需要 DSH、Cordis、profile 或宿主凭据库；管理页与推理都只监听回环。
- 独立安装制品/Release 尚未发布，当前必须从完整源码仓库运行（上游 README 原话）。
- 停止：终端 `Ctrl+C`；异常退出若残留 `service.lock`，先确认 PID 已退出再删除。
- 管理页链接 10 分钟内有效、仅能兑换一次；后续可用 `settings.json` 的 `forwardKey` 登录。

### 1.4 不要使用的安装方式

| 方式 | 原因 |
|---|---|
| `npm install dsh-our-free-model` | 上游声明 npm 同名包为第三方改动版，非本仓库发布 |
| 只复制 `index.js` / `client.js` / `src` 三个入口 | 渠道加载会失败，必须整包（含 `adapter/`、`vendor/channel-pack/`） |
| 把 `forward` 绑到 `0.0.0.0` | 会用本机免费额度服务整个子网；上游会拒绝非回环地址 |
| 在文档/脚本里写死 `forwardKey` | 属于共享泄露 Key，本次明确禁止 |

---

## 2. 本机实测结果

### 2.1 本机环境

| 项 | 值 |
|---|---|
| 项目目录 | `C:\Users\whylh\Documents\金融项目\参赛方案_资金安全管家` |
| DSH | `dsh 0.2.1-rc.2`（`C:\Users\whylh\AppData\Local\Programs\DeepSeek Harness\...\dsh.cmd`） |
| DSH_HOME | `C:\Users\whylh\.dsh` |
| Profiles | `acp`、`desktop`、`headless`、`web` |
| 插件安装情况 | **未安装**（4 个 profile 的 `package.json` 均无该 bundle；无 `~/.dsh/our-free-model`） |
| Node / npm | `v24.19.0` / `11.17.0` |
| 项目服务 | 已有一个 `node server.mjs` 监听 `0.0.0.0:4173`，AI 未配置 |

### 2.2 端口探测（`Get-NetTCPConnection` + 实际 HTTP 请求）

| 端口 | 归属 | 实测状态 |
|---|---|---|
| `18900` | 独立服务默认端口 | **本次实际启动并验证**；测试结束后已停止 |
| `4173` | 本项目现有实例（探测时） | 当时正在监听；`/api/health` 显示 `configured:false`、`baseUrl:http://127.0.0.1:3000/v1`、`model:auto`。该实例在并行改动中已被重启/停止，当前以实际端口探测为准 |
| `3000` | 项目默认的 New API 聚合网关 | **未监听**，所以当前 `npm start` 必然显示未配置 |
| `18899` | DSH 插件转发端口默认值 | **未监听**（插件未装，且 `forward.enabled` 默认 `false`） |
| `8326` | 插件内账号渠道网关默认端口 | 未监听 |
| `18326` | 插件 LAN 中继默认端口 | 未监听 |
| `19900` | 本机另一个 ZCode 代理（`../scripts/zcode-proxy.mjs`，GLM-5.3-Flash） | 监听 `127.0.0.1:19900`；**与本任务无关，未复用、未改动** |
| `4183/4184/4185` | 本次验证临时启动的项目实例 | 测试结束后已停止 |

> 结论：本机唯一可用的、属于该 GitHub 项目的 OpenAI 兼容网关是 `127.0.0.1:18900`（本次拉起）。插件默认的 18899 目前不存在。

### 2.3 接口探测（18900，实测）

| 请求 | 结果 |
|---|---|
| `GET /health`（无鉴权） | `200`，`{"ok":true,"service":"our-free-model-standalone","product":"standalone","version":"2.5.4","capabilities":{...}}` |
| `GET /v1/models`（无 Key） | `401`，`missing or invalid API key` |
| `GET /v1/models`（Bearer `forwardKey`） | `200`，**27 个模型** |
| `POST /v1/chat/completions`（`kilo-auto/free`） | `200`，2768 ms，正常 `choices[0].message.content` |
| `POST /v1/chat/completions` + `tools` / `tool_choice:auto`（`kilo-auto/free`） | `200`，3025 ms，返回 `finish_reason:"tool_calls"` 与 `get_bills({"limit":3})` |
| `POST /v1/chat/completions`（`deepseek-v4.1-flash-free`） | `429`，`Free usage limit reached. Subscribe to OpenCode Go...` |
| `POST /v1/chat/completions`（`glm-5.3-flash-free`） | `429`，同上 |
| `POST /v1/chat/completions`（`combo:recommended-free`） | `502`，链路逐个 429 后耗尽（`deepseek... 429`、`glm... 429`） |
| `POST /v1/chat/completions`（不存在的模型） | `404`，`model "..." not found` |
| 23:15 复测（kilo / big-pickle / openrouter / mimo） | 全部 `502 TRANSPORT`：`Client network socket disconnected before secure TLS connection was established (ECONNRESET)`，属本机出口网络波动，不是 Key 或端口问题 |

`/v1/models` 返回的 27 个 id：

```
big-pickle, beam-free, flint-40b-free, mimo-v2.6-flash-free, nemotron-3.5-super-vl-free,
nemotron-3.5-lightning-free, jev-1.13-free, deepseek-v4.1-flash-free, glm-5.3-flash-free,
kilo-auto/free, nvidia/nemotron-3.5-super-vl:free, reflection/beam-free, stealth/glyph-cluster,
recursive/flint-v1.0:free, xingchen-agi/xing4.0-29b-a4b:free,
dots-studio/dots-3-note-preview:free, liquid/lfm-2.5-2.6b:free,
nvidia/nemotron-3.5-lightning:free, poolside/laguna-s-2.1:free, poolside/laguna-xs-2.1:free,
cohere/north-mini-code:free, nvidia/nemotron-3.5-content-safety:free,
nvidia/nemotron-3-ultra-550b-a55b:free, nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free,
nvidia/nemotron-3-super-120b-a12b:free, openrouter/free, combo:recommended-free
```

`/v1/responses` 与 `/v1/messages` 由上游 README 声明支持，**本次未逐一实测**（本项目只走 Chat Completions，不依赖它们）。

### 2.4 端到端实测（本项目 `POST /api/agent`）

| 场景 | 请求 | 结果 | 耗时 |
|---|---|---|---|
| 手动 env 启动（4183） | 「发薪前这 13 天怎么安排？」 | `200`，`source:"ai"`，5 个工具全部调用，`plan.actions` 5 条 | 37.0 s |
| 包装脚本冷启动（4184） | 「本月账单里哪几笔最急？」 | `200`，5 个工具，`plan.actions` 3 条 | 50.7 s |
| 包装脚本冷启动（4185，最终版） | 仅健康检查 | `configured:true`，`baseUrl:http://127.0.0.1:18900/v1`，`model:kilo-auto/free` | 启动约 3–5 s |
| 现状 `npm start` 脚本（4188） | 复用已有 18900 网关 | 健康检查 `configured:true`；但 23:15 触发 Agent 时上游 `ECONNRESET`，项目返回 `502 AI_UPSTREAM_ERROR` | 0.4 s 失败 |

这两次端到端证明了三件事：

1. 本项目现有的工具调用协议（`tools` + `tool_choice:auto` + `tool` 角色回传）与网关兼容。
2. 网关返回的是标准 OpenAI Chat Completions，本项目无需改协议。
3. 免费模型可能较慢（单轮 3–15 s，整次 37–51 s），但未触发 `server.mjs` 现有的 45 s **单次调用**超时。

### 2.5 实测结论

- **能安全接入**：网关只监听 `127.0.0.1`，Key 本机生成，项目只从服务端读取，前端拿不到。
- **默认模型不能写 `deepseek-v4.1-flash-free`**：本机当前 429；写死会让「开箱即用」直接失败。
- **`combo:recommended-free` 也不稳**：它当前的前两个链接都在 OpenCode 车道且 429，第三条 `space-bunny-free` 已不在清单，导致 502。
- **`kilo-auto/free` 是当前最稳的默认值**，且支持工具调用；它属于 Kilo 免费池，上游声明 prompt 可能被记录，**资金数据场景必须提示用户不要输入真实敏感信息**。
- **免费车道可用性会波动**：23:05 实测 `kilo-auto/free` 正常并完成两轮 Agent；23:15 复测所有模型（含 big-pickle、openrouter/free、mimo）统一返回 `502 TRANSPORT / ECONNRESET`，属出口网络或上游连接问题。因此「开箱即用」只能是「有网且出口可达时可用」，脚本与界面必须给出可读错误，并保留 `OFM_MODEL` 与外部 `AGGREGATOR_*` 的切换能力。
- OpenCode 的 429 是会话/出口级限流，可能随时间恢复；脚本应允许 `OFM_MODEL` 覆盖，并在模型不在清单时自动回退。

---

## 3. 安全接入方案（推荐）

### 3.1 目标架构

```
浏览器 (index.html，不改)
   │  POST /api/agent
   ▼
本项目 server.mjs  ── AGGREGATOR_BASE_URL=http://127.0.0.1:18900/v1 ──►  Our Free Model 独立服务
   │                AGGREGATOR_API_KEY=<本机 forwardKey，仅服务端>            │ 127.0.0.1:18900
   └──────────────────────────────────────────────────────────────────────► 上游免费车道
```

- 前端只与本项目同源通信，**永远看不到网关 Key**。
- 网关只绑回环，不启用 LAN 中继，不把 18900 暴露到局域网。
- `server.mjs` **不新增**从文件读 Key 的逻辑，避免 `scripts/check.mjs` 的「无 Key 必须未配置」断言被本机数据目录污染；Key 由包装脚本在进程环境里注入。

### 3.2 环境变量（三种等价写法）

**方式 1：包装脚本（推荐，Key 不落终端、不进仓库）**

```powershell
npm run start:free
```

**方式 2：手动设置后普通启动（调试用）**

```powershell
$ofm = Join-Path $HOME '.our-free-model\settings.json'
$env:AGGREGATOR_BASE_URL = 'http://127.0.0.1:18900/v1'
$env:AGGREGATOR_API_KEY  = (Get-Content $ofm -Raw | ConvertFrom-Json).forwardKey
$env:AGGREGATOR_MODEL    = 'kilo-auto/free'
npm run start:plain
```

> 注意：不要把上面这条 `Get-Content` 的输出粘贴到聊天、Issue 或文档里；它就是把本机网关 Key 打印出来。

**方式 3：一次性命令行（不修改当前 shell）**

```powershell
$ofm = Join-Path $HOME '.our-free-model\settings.json'
$env:AGGREGATOR_BASE_URL='http://127.0.0.1:18900/v1'
$env:AGGREGATOR_API_KEY=(Get-Content $ofm -Raw | ConvertFrom-Json).forwardKey
$env:AGGREGATOR_MODEL='kilo-auto/free'
node server.mjs
```

变量优先级保持不变：`AGGREGATOR_*` → `AI_GATEWAY_*` → `ARK_*` → `DEEPSEEK_*`。设置 `AGGREGATOR_*` 后不会触碰原有 Ark/DeepSeek 配置。

### 3.3 工作区现状与要动的文件（核对时间 2026-10-24 23:13）

调查期间，工作区被并行改动，最小链路已经落地（**不是本次调查所做的修改**，这里只做核对与加固建议）：

| 文件 | 现状（23:13） |
|---|---|
| `package.json` | `start` 已改为 `node scripts/start-with-free-model.mjs` |
| `scripts/start-with-free-model.mjs` | 已存在（123 行），首次运行会 `git clone` 到项目 `vendor/`；默认模型已改为 `kilo-auto/free` |
| `README.md` | 启动段已改写，默认模型已写为 `kilo-auto/free`（与实测一致） |
| `vendor/dsh-our-free-model` | 已克隆（HEAD，**未固定 commit**） |
| `index.html` | 未改动（mtime 仍为 22:50） |
| `server.mjs` | 未改动（仍是 45 s 固定超时） |

#### (1) `scripts/start-with-free-model.mjs`（已存在，需要加固）

现状脚本的优点是：`npm start` 一条命令、自动 clone、自动读 Key、自动注入 `AGGREGATOR_*`，方向正确。默认模型在 23:13 已改成 `kilo-auto/free`，这一点与第 2 节实测一致，**不要回退成 `deepseek-v4.1-flash-free`**（本机当前 429）。

截至 23:13，仍有 4 个问题会让「开箱即用」失败或留下隐患：

| # | 问题 | 证据 / 影响 | 建议 |
|---|---|---|---|
| 1 | `candidateDataDirs()` 会扫描 `%TEMP%\ofm-data` | 本机实测该目录存在测试 Key，会被误当成本机正式 Key | 只认 `OFM_HOME` / `~/.our-free-model`；删除 tmp 候选 |
| 2 | 端口顺延后不跟随 | 18900 被占用时服务实际起在 18901，脚本仍轮询 18900，60 s 后报错（本机已出现 18901 实例） | 启动后在 `REQUESTED_PORT..+19` 内探测 `/health` 并采纳实际端口，或读 `settings.json` 的 `standalonePort` |
| 3 | 网关 `detached + unref`，脚本退出不回收 | 反复调试会留下孤儿进程（本机已有 18901 孤儿） | 默认随项目退出回收；需要常驻时用 `OFM_KEEP_GATEWAY=1` |
| 4 | clone 到 `vendor/` 且无 `.gitignore`、未固定 commit | 约 35 MB 进入项目目录，且每次拉 HEAD 不可复现 | 克隆到 `~/.dsh-free-model-src`，或至少加 `.gitignore` 并 `checkout --detach <已验证 commit>` |

对应最小补丁：

```js
// 1) 默认模型保持实测可用的（23:13 已修正，勿回退到 deepseek-v4.1-flash-free）
const MODEL = process.env.OFM_MODEL || 'kilo-auto/free';

// 2) 去掉临时目录候选
function candidateDataDirs() {
  return [...new Set([process.env.OFM_HOME, DATA].filter(Boolean))];
}

// 3) 启动后采纳实际端口（health 轮询）
for (let port = REQUESTED_PORT; port < REQUESTED_PORT + 20; port += 1) {
  if ((await request(port, '/health')).status === 200) { runtimePort = port; break; }
}
```

第 3、4 项按第 4.2 节的参考实现处理（子进程随退出回收、克隆到用户目录并固定 commit）。

#### (2) 不需要额外的 bootstrap 脚本

现状脚本已经内置 `git clone`，因此第 4.3 节的 PowerShell 引导只作为「想固定版本/离线部署」时的可选方案，不是必须。

#### (3) `package.json`（建议的最终形态）

当前只改了 `start`。建议补上回退入口，便于排障：

```json
{
  "scripts": {
    "start": "node scripts/start-with-free-model.mjs",
    "start:plain": "node server.mjs",
    "start:free": "node scripts/start-with-free-model.mjs",
    "proxy": "node ../scripts/zcode-proxy.mjs",
    "check": "node --check server.mjs && node scripts/check.mjs",
    "smoke": "node scripts/smoke.mjs"
  }
}
```

- `scripts/check.mjs` 与 `scripts/smoke.mjs` 都直接 `spawn(node, ['server.mjs'])`，不经过 `npm start`，不受影响。
- 现有脚本在网关失败时是**直接退出**，不是回退普通启动；若希望页面在无网关时仍可打开，应采用 4.2 节的 `try/catch` 回退分支。

#### (4) `server.mjs`（可选，仅超时）

现有 45 s 是写死的单次模型调用超时（第 302 行）。免费模型偶发慢响应，建议改成可配置、默认值不变：

```js
// 第 186 行附近，AI 配置区
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 45000);
const AI_TIMEOUT = Number.isFinite(AI_TIMEOUT_MS) && AI_TIMEOUT_MS > 0 ? AI_TIMEOUT_MS : 45000;

// 第 302 行
const timer = setTimeout(() => { if (controller) controller.abort(); }, AI_TIMEOUT);
```

启动时可加 `$env:AI_TIMEOUT_MS='90000'`。默认行为与现在完全一致，`npm run check` 不受影响。

**不建议**在 `server.mjs` 里自动读取 `~/.our-free-model/settings.json`：那会让 `check.mjs` 在已配置本机网关的机器上把 `configured:false` 断言跑挂，也会让「未配置」状态不再可测。

#### (5) `README.md`（已基本对齐，建议改一处示例）

现状 README 已改成「`npm start` 自动准备网关」，默认模型也已写为 `kilo-auto/free`（23:13），与实测一致。唯一建议修正的是这句示例：

> 也可以在启动时固定到 DeepSeek V4.1 Flash 或网关清单里的其它模型

本机 `deepseek-v4.1-flash-free` 当前 429，把它当作示例会让读者第一次尝试就失败。建议改成：

```markdown
也可以切换到网关清单里的其它模型（例如 `glm-5.3-flash-free`）：
$env:OFM_MODEL = 'glm-5.3-flash-free'; npm start
```

并补一句「手动设置 `AGGREGATOR_*` 会覆盖内置服务」。

#### (6) `.gitignore`（现状必须补）

现状已经把上游克隆进 `vendor/dsh-our-free-model`（约 35 MB），但项目没有 `.gitignore`。必须新增：

```gitignore
vendor/dsh-our-free-model/
.ofm-*/
node_modules/
```

更稳妥的做法是按 4.2 节把默认克隆位置改到 `~/.dsh-free-model-src`，项目目录只留脚本。

### 3.4 为什么这样不会泄露 Key

- `forwardKey` 由本机服务用 `crypto` 生成，只存在 `~/.our-free-model/settings.json`。
- 包装脚本在运行时读取，只放进子进程环境变量，不写文件、不打印、不进日志。
- 项目 `/api/health` 只回显 `configured/model/provider/baseUrl`，**不回显 Key**（已实测）。
- 仓库中不会出现任何 Key 字面量；没有 `.env` 被提交。
- 不使用 DeepSeek 官方 API，也不依赖任何第三方共享中转。

### 3.5 备选：插件形态的接入参数

如果后续坚持「DSH 内置」而不是独立服务，按下面接：

1. 安装并重启（见 1.2）。
2. 开启转发（默认关闭），编辑 `%DSH_HOME%\our-free-model\settings.json` 的 `forward` 段（**只改这一段，不要整体覆盖文件**）：

```json
{
  "forward": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 18899,
    "lan": { "enabled": false, "port": 0 }
  }
}
```

3. 重启 DSH，确认 18899 在监听；端口被占用时插件会顺延，实际值写回 `settings.json`。
4. 取 Key：`GET /api/our-free-model/forward/key`（需要 DSH 自身的 cookie/token），或读同一 `settings.json` 的 `forwardKey`。
5. 本项目改用：

```powershell
$env:AGGREGATOR_BASE_URL='http://127.0.0.1:18899/v1'
$env:AGGREGATOR_API_KEY='<插件 forwardKey>'
$env:AGGREGATOR_MODEL='kilo-auto/free'
npm run start:plain
```

包装脚本也支持这条路线，不需要改代码：

```powershell
$env:OFM_SKIP_GATEWAY = '1'      # 只复用，不拉起独立服务
$env:OFM_PORT         = '18899'  # 插件转发端口
$env:OFM_KEY_FILE     = Join-Path $env:DSH_HOME 'our-free-model\settings.json'
$env:OFM_MODEL        = 'kilo-auto/free'
npm run start:free
```

`OFM_SKIP_GATEWAY=1` 时脚本只做健康检查与读 Key；网关是插件进程，脚本退出时**不会**关闭它。该分支已在本机用独立服务模拟验证（复用现有网关、读外部 Key 文件、退出不误杀）。

**风险**：插件 README 标注适配 `0.1.5–0.1.7-rc.2`，本机 `0.2.1-rc.2` 未验证；且插件必须随 DSH 一起运行，项目单独部署时不可用。因此不作为默认方案。

---

## 4. 开箱即用启动脚本设计（插件未安装场景）

> 以下版本已在 Node v24.19.0 上完整实测（冷启动、复用、外部 Key 文件三条路径）。现状脚本的 4 个问题见 3.3(1)，可直接用本节版本替换；若只做最小改动，至少先删除 `%TEMP%` 候选目录并处理端口顺延。

### 4.1 设计流程

```
npm run start:free
  ├─ 1. 解析 OFM_REPO（默认 ~/.dsh-free-model-src）
  ├─ 2. GET 127.0.0.1:18900/health
  │     ├─ 200 → 复用已有网关（不重复拉起）
  │     ├─ OFM_SKIP_GATEWAY=1 → 只复用，不拉起；没有健康网关则回退普通启动
  │     └─ 失败 → 端口被占则报错；否则 spawn 独立服务，轮询 /health ≤60s
  ├─ 3. 从 <OFM_HOME>/settings.json 读 forwardKey（可用 OFM_KEY_FILE 覆盖，最多等 5s）
  ├─ 4. GET /v1/models 校验模型；不在清单则回退 kilo-auto/free
  ├─ 5. spawn node server.mjs，注入 AGGREGATOR_*，stdio 继承
  └─ 6. 退出时回收自己拉起的网关；复用来的网关不动
```

设计原则：

- **不猜端口**：固定 18900；被别的程序占用时明确报错，让用户 `OFM_PORT` 换端口，而不是启动到未知端口。
- **失败开放**：网关不可用时回退 `node server.mjs`，页面仍可打开，只是 AI 未配置。
- **不写 Key**：只在内存与环境变量中传递。
- **可复用**：已有网关（例如用户自己开的）直接复用，退出时不会误杀。
- **日志固定**：网关 stdout/stderr 追加到 `<OFM_HOME>/service.log`，便于排障。

### 4.2 `scripts/start-with-free-model.mjs`（已验证可运行）

```js
/**
 * 开箱即用：启动 Our Free Model 本地网关（如未运行），再以 AGGREGATOR_* 环境变量启动本项目。
 * 不写入任何密钥；forwardKey 在运行时从本机 settings.json 读取。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.OFM_REPO || path.join(os.homedir(), '.dsh-free-model-src');
const DATA = process.env.OFM_HOME || path.join(os.homedir(), '.our-free-model');
const PORT = Number(process.env.OFM_PORT || 18900);
const MODEL = process.env.OFM_MODEL || 'kilo-auto/free';
const CLI = path.join(REPO, 'packages', 'standalone', 'cli.mjs');
const SKIP_GATEWAY = process.env.OFM_SKIP_GATEWAY === '1';
const KEY_FILE = process.env.OFM_KEY_FILE || path.join(DATA, 'settings.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(port, pathname, headers = {}, timeoutMs = 1500) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers, timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function healthy(port) {
  const result = await request(port, '/health');
  return Boolean(result && result.status === 200);
}

function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(false));
  });
}

async function startGateway() {
  if (await healthy(PORT)) return null; // 已有本机网关，直接复用
  if (SKIP_GATEWAY) throw new Error(`OFM_SKIP_GATEWAY=1 但 127.0.0.1:${PORT} 没有可用的 /health`);
  if (await portBusy(PORT)) throw new Error(`端口 ${PORT} 被其它程序占用，请设置 OFM_PORT 换一个端口`);
  if (!fs.existsSync(CLI)) throw new Error(`未找到本地网关：${CLI}\n先把仓库克隆到 OFM_REPO，或用 OFM_REPO 指向已有目录`);
  fs.mkdirSync(DATA, { recursive: true });
  const log = fs.openSync(path.join(DATA, 'service.log'), 'a');
  const child = spawn(process.execPath, [CLI, '--port', String(PORT), '--data-dir', DATA], {
    stdio: ['ignore', log, log], windowsHide: true,
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await healthy(PORT)) return child;
    if (child.exitCode !== null) throw new Error(`网关启动失败（exit ${child.exitCode}），日志：${path.join(DATA, 'service.log')}`);
    await sleep(500);
  }
  child.kill();
  throw new Error(`网关 60 秒内未就绪，日志：${path.join(DATA, 'service.log')}`);
}

async function readKey() {
  const file = KEY_FILE;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const key = JSON.parse(fs.readFileSync(file, 'utf8')).forwardKey;
      if (key) return key;
    } catch { /* 等待网关写入 */ }
    await sleep(250);
  }
  throw new Error(`无法从 ${file} 读取 forwardKey`);
}

let gateway = null;
let app = null;
let stopping = false;

function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (app && app.exitCode === null) app.kill(); } catch { /* 已退出 */ }
  try { if (gateway && gateway.exitCode === null) gateway.kill(); } catch { /* 已退出 */ }
}

try {
  gateway = await startGateway();
  const key = process.env.OFM_API_KEY || await readKey();
  let model = MODEL;
  const listed = await request(PORT, '/v1/models', { Authorization: `Bearer ${key}` }, 5000);
  try {
    const ids = JSON.parse(listed.body).data.map(item => item.id);
    if (ids.length > 0 && !ids.includes(model)) {
      const fallback = ids.includes('kilo-auto/free') ? 'kilo-auto/free' : ids[0];
      console.warn(`[free-model] 模型 ${model} 不在清单中，改用 ${fallback}`);
      model = fallback;
    }
  } catch { /* 清单暂不可读时不阻塞启动 */ }
  console.log(`[free-model] 网关 http://127.0.0.1:${PORT}/v1 · 模型 ${model}`);
  app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGGREGATOR_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
      AGGREGATOR_API_KEY: key,
      AGGREGATOR_MODEL: model,
    },
  });
  app.on('exit', code => { shutdown(); process.exit(code ?? 0); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdown(); process.exit(0); });
} catch (error) {
  shutdown();
  console.warn(`[free-model] ${error.message}\n[free-model] 回退为普通启动：AI 未配置。`);
  app = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { stdio: 'inherit' });
  app.on('exit', code => process.exit(code ?? 0));
}
```

> 该脚本已在 Node v24.19.0 上实测：冷启动拉起网关、读取 Key、校验模型、启动项目、`/api/health` 返回 `configured:true`，全部通过。

### 4.3 `scripts/bootstrap-free-model.ps1`（一次性引导）

```powershell
$ErrorActionPreference = 'Stop'

$repo = if ($env:OFM_REPO) { $env:OFM_REPO } else { Join-Path $HOME '.dsh-free-model-src' }
$pin  = 'f3ecb7abcf5a0351645cfcbd638b9c7fbbcb3e97'

if (-not (Test-Path (Join-Path $repo 'packages\standalone\cli.mjs'))) {
  if (Test-Path $repo) { throw "目录已存在但不是完整仓库：$repo" }
  git clone https://github.com/Ebony-Vinyl/dsh-our-free-model.git $repo
  git -C $repo checkout --detach $pin
}

$node = (Get-Command node -ErrorAction Stop).Source
$version = (& $node --version).TrimStart('v')
$parts = $version.Split('.') | ForEach-Object { [int]$_ }
if (-not (($parts[0] -eq 22 -and $parts[1] -ge 19) -or $parts[0] -ge 24)) {
  throw "需要 Node ^22.19.0 或 >=24.0.0，当前 $version"
}

Write-Host "已就绪：$repo"
Write-Host "下一步：npm run start:free"
```

固定 commit 的理由：上游仍在快速迭代（本次 24 小时内 HEAD 已变化），固定版本可复现；升级时改 `$pin` 并重跑。

### 4.4 首次使用

现状脚本（自动 clone）：

```powershell
npm start
# 浏览器打开 http://localhost:4173
```

若采用本节的参考实现（需先把脚本替换为 4.2 版本、并加 `start:free`）：

```powershell
npm run start:free
```

> 若 4173 已被旧实例或其它程序占用，先停掉再启动，否则新实例会以 `EADDRINUSE` 退出。

开发调试仍可用（若已按 3.3(3) 添加 `start:plain`）：

```powershell
npm run start:plain   # 不带内置 AI，保持原行为
```

### 4.5 失败模式与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `未找到本地网关` | 首次 `git clone` 失败，或 `OFM_REPO` 不对 | 确认 `git ls-remote https://github.com/Ebony-Vinyl/dsh-our-free-model.git` 可通；或 `$env:OFM_REPO='D:\...\dsh-our-free-model'` |
| `端口 18900 被其它程序占用` | 其它服务占用 | `$env:OFM_PORT='18902'` 后重试（脚本会把新端口传给项目） |
| 网关 60 s 未就绪 | 首次启动慢 / 数据目录锁 | 看 `<OFM_HOME>\service.log`；确认没有残留 `service.lock` 指向活进程 |
| 模型返回 429 | OpenCode 免费车道限流 | 用 `$env:OFM_MODEL='kilo-auto/free'`；或等限流恢复；不要写死 `deepseek-v4.1-flash-free` |
| 模型返回 502 | combo 链路全部失败 | 换单模型；或自定义 combo 把 `kilo-auto/free` 放链首 |
| 单次模型调用超过 45 s 超时 | 免费模型长思考 | 设 `$env:AI_TIMEOUT_MS='90000'`（需先做 3.3(4) 的补丁） |
| 强制结束终端后 18900 仍占用 | Windows 强杀不触发子进程回收 | `Get-NetTCPConnection -LocalPort 18900` 找 PID 后 `Stop-Process`；正常 `Ctrl+C` 会自动回收 |

### 4.6 Windows 注意事项

- 路径含中文/空格已实测可用（`C:\Users\whylh\Documents\金融项目\...`）。
- 用 `spawn(node, [args])` 数组参数，不经过 shell，避免引号问题。
- 网关子进程用 `windowsHide: true`，不额外弹窗。
- 若用 PowerShell 7 的 `Start-Process` 包一层，注意 `Ctrl+C` 不会传给孙进程；优先直接 `npm run start:free`。
- 数据目录默认在用户目录，不写入项目目录，避免被误提交。

---

## 5. 验收清单

接入后按顺序执行：

```powershell
# 1. 语法与静态检查（保持现有断言全绿）
npm run check

# 2. 网关存活
(Invoke-WebRequest http://127.0.0.1:18900/health -UseBasicParsing).StatusCode   # 200

# 3. 模型真的能出字（清单里有 ≠ 可用；deepseek-v4.1-flash-free 当前会 429）
$k = (Get-Content (Join-Path $HOME '.our-free-model\settings.json') -Raw | ConvertFrom-Json).forwardKey
$b = @{ model='kilo-auto/free'; messages=@(@{role='user'; content='ping'}); max_tokens=8 } | ConvertTo-Json -Depth 5
(Invoke-WebRequest http://127.0.0.1:18900/v1/chat/completions -Method POST `
  -Headers @{ Authorization = "Bearer $k" } -ContentType 'application/json' -Body $b -UseBasicParsing).StatusCode  # 200

# 4. 项目健康检查
(Invoke-WebRequest http://127.0.0.1:4173/api/health -UseBasicParsing).Content
# 期望：ai.configured=true, ai.baseUrl=http://127.0.0.1:18900/v1, ai.model=kilo-auto/free

# 5. 真实一轮 Agent（会消耗免费额度）
$body = @{ text = '先查账单和卡片，再告诉我本周最急的三件事。' } | ConvertTo-Json
Invoke-WebRequest http://127.0.0.1:4173/api/agent -Method POST -ContentType 'application/json' -Body $body -UseBasicParsing
# 期望：ok=true, source=ai, queries 覆盖 5 个工具（或至少账单/卡片），plan.actions ≥1
```

人工检查：

- [ ] 浏览器打开 4173，首页正常，设置页 AI 状态显示已连接。
- [ ] 断网/网关停止时，页面仍可打开，错误提示为「模型服务连接失败」而不是白屏。
- [ ] 仓库中 `git grep -i "forwardKey\|sk-"` 无命中（当前项目不是 git 仓库，至少人工确认文档无 Key 字面量）。
- [ ] 18900 只监听 `127.0.0.1`，不是 `0.0.0.0`。
- [ ] `index.html` 未被修改。

---

## 6. 回滚

1. `package.json` 的 `start` 改回 `node server.mjs`（或直接用 `npm run start:plain`）。
2. 删除 `scripts/start-with-free-model.mjs`（若已按 4.3 添加，再删 `scripts/bootstrap-free-model.ps1`）。
3. 停止网关：`Ctrl+C`；或按端口找 PID 后停止。
4. 可选删除 `~/.our-free-model`（会丢失本机 Key 与用量统计）；若克隆在 `vendor/`，一并删除 `vendor/dsh-our-free-model`（35 MB）。

回滚不影响 Ark/DeepSeek 原有配置；环境变量优先级未改变。

---

## 7. 证据与参考

- 仓库：<https://github.com/Ebony-Vinyl/dsh-our-free-model>
- 插件安装与桌面端限制：仓库 `README.md` → 「安装」
- 独立服务启动、数据目录、鉴权：仓库 `packages/standalone/README.md`
- 转发端口默认值：`src/store.js`（`host: 127.0.0.1`、`port: 18899`、`enabled: false`）
- 插件数据目录：`$DSH_HOME/our-free-model`（`src/store.js`）
- 上游免费车道与 Kilo 池说明：仓库 `README.md` → 「上游是哪些源」「免责声明」
- 本次实测命令与输出：见第 2 节（18900 已停止，4173 原实例未改动）

> 隐私提醒：Kilo 免费池的模型卡明确声明 prompt 可能被上游记录并用于改进服务。本项目是资金场景，演示数据虽为虚构，仍应在界面上提示「不要输入真实账号、密码、身份证或银行卡信息」；生产环境应改用自建/付费网关。
