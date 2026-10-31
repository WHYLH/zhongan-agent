# 墨金定制图标系统

## 来源与执行方式

- 设计清单由主代理定义。
- 原生 ZCode 图标子代理因宿主 `provider-not-found` 无法启动。
- SVG 几何绘制由用户指定的火山方舟 `kimi-k3.1-pro` 独立任务完成，主代理负责检查、整合与浏览器验收。
- 所有图标都在本目录 `icons.svg`，无外部图标库、字体、图片或网络请求。

## 规格

- 24×24 viewBox，1.4px currentColor 描边，round linecap / linejoin。
- 使用少量切角、轨道、刻度和节点，适配日间雾银和深曜背景。
- 功能图标表达业务语义，不再混用普通柱状图、五角星和齿轮。
- 16–22px 主要显示尺寸下检查辨识度，装饰细节不代替文字标签。

## 图标清单

| Symbol id | 用途 | 设计语义 |
|---|---|---|
| `i-xiaoan` | 品牌 | A 字切角、轨道与资金节点 |
| `i-chat` | 对话、助手 | 对话轮廓与智能节点轨迹 |
| `i-send` | 发送 | 上行轨迹与输入基线 |
| `i-mic` | 语音输入 | 切角麦克风与聆听刻度 |
| `i-speaker` | 朗读 | 声波与发声节点 |
| `i-accounts` | 账号 | 卡片、芯片与账户刻线 |
| `i-assets` | 资产 | 分层资产与组合节点 |
| `i-cashflow` | 收支 | 双向资金流 |
| `i-loans` | 贷款 | 额度弧、刻度与指针 |
| `i-wealth` | 理财 | 产品档案与收益刻线 |
| `i-payments` | 服务 | 周期扣款与连接 |
| `i-settings` | 设置 | 精密调节轨 |
| `i-details` | 明细 | 账目分栏 |
| `i-transfer` | 转账 | 双向账户划转 |
| `i-copy` | 复制 | 双层凭证 |
| `i-lock` | 挂失/保护 | 卡片与锁扣 |
| `i-password` | 密码管理 | 密钥与密码节点 |
| `i-receipt` | 回执 | 回执纸面与完成刻线 |
| `i-success` | 完成 | 切角完成标记 |
| `i-pending` | 待处理 | 时间轨迹 |
| `i-alert` | 异常 | 警戒节点 |
| `i-close` | 关闭 | 关闭与边界切角 |
| `i-back` | 返回 | 回退轨迹 |
| `i-arrow` | 进入 | 前进行动轨迹 |

## 使用

静态 SVG：

```html
<svg class="obs-icon" viewBox="0 0 24 24" aria-hidden="true">
  <use href="./assets/icons.svg#i-accounts"></use>
</svg>
```

页面脚本使用 `obsIcon(name)` 生成相同结构。保留原按钮的文字、aria-label 和事件；图标只是展示资源。

## 验收

- 24 个 id 完整，path 不含外部资源、文字或栅格图片。
- 首页、功能索引、底部导航、账户快捷动作和弹层关闭使用统一资源。
- 日间/深色、手机/桌面下图形完整，不被裁切，不依赖颜色传达唯一含义。
