# 权限规划与 IM 技术准备稿

本文件是技术方案总览的深度补充，串起第 1 项权限分级、第 3 项意图理解/任务规划，以及 IM 渠道的接口、票据、幂等和企业微信接入。

## 权限分级与任务规划

完整论证、接口结构、任务 DAG 与审稿清单见项目根目录的 [REQUIREMENTS_1_3_IM_TECHNICAL_DRAFT.md](../../REQUIREMENTS_1_3_IM_TECHNICAL_DRAFT.md)。该文件保留为权限与规划部分的详细草稿。

## IM 渠道

IM 渠道的定稿见项目根目录的 [IM_TECHNICAL_PREPARATION.md](../../IM_TECHNICAL_PREPARATION.md)，包含：

- 官方 `bank-agent-starter-0.2.0` 的逐文件结论与压缩包 SHA-256；
- 通用 Webhook 的 HMAC 签名、时间窗、messageId 幂等与响应契约；
- 企业微信 GET 验签、AES-256-CBC 解密、POST 解析、用户绑定、群聊会话；
- access_token 缓存、`message/send` 异步回执与 dry-run；
- 跨渠道票据、Web 确认链接与“IM 不接收密码”的强验证边界；
- 实现落点、P0/P1/P2 步骤与 55 条验收用例；
- 本地一条命令 `npm run im:demo`：自动跑签名 Webhook、加密企微回调和票据链接。

结论：赛题要求 APP / IM 等渠道联通，未指定具体 IM 平台。通用 Webhook 与企业微信适配器已实现，`npm run im:check` 55 条全过；企业微信真实租户联调仍需企业凭据，协议算法与 dry-run 可在本地完整验证。