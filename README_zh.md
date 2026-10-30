# dsh-taste-loop（品味闭环插件）

DeepSeek Harness（DSH）插件（host-only）：给各域 agent 提供自助**品味协议**——记录判断、自助提出/修订版本化规则、独立 session 共识生效、分歧人工仲裁。

## 工具

| 工具 | 用途 |
|---|---|
| `taste_rules` | 已登记规则 + 提案状态（effective / pending_review / needs_arbitration） |
| `taste_case` | 确定性案例 ID——同一判断点永远同一 ID |
| `taste_record` | 把品味判断写入验证器收件箱 |
| `taste_queue` | 人工仲裁/结算队列快照 |
| `taste_update` | 自助规则生命周期：`propose / list / blind / endorse / resolve` |

## 自助规则生命周期

1. 任一域 agent 创建或修订**版本化规则提案**（`taste_update propose`）。历史为追加式 JSONL，提交不自动生效。
2. 作者之外**两个不同 DSH session**（`ctx=decision:` 不计独立来源）对同一版本同向背书 → 成为域内 `effective` 版本。共识 `effective` 与人工 `ratified` 始终分开呈现。
3. 两个不同 session 独立反向 → 进入 `needs_arbitration`，争议期间保留上一生效版本。
4. 人工仲裁者（`arbiterSessionIds` 名单内 session）裁决；每次裁决追加 claim 与 resolution 记录。

**安全边界：** 只带自报 `X-Market-Client` 头的直接 HTTP 调用方只能写普通判断，**不能**提出共享规则、背书或裁决。工作台市场网关可通过共享密钥 `marketGatewayKey`（两侧配置）获得信任：携带匹配 `X-Market-Gateway-Key` 的请求，其网关会话身份 `mcp/<名>` 升级为可信 `market/<名>` session，可提案与背书。人工裁决（`resolve`）仍只限配置的 DSH `arbiterSessionIds`。提案/背书/仲裁账本以可崩溃恢复的文件锁串行化。

## 安装

本地检出安装（当前推荐）：

```bash
dsh plugin --profile web add /path/to/dsh-taste-loop
```

GitHub 源码安装：`prepare` 脚本会构建 `lib/`，但 `@deepseek-ai/*` peers 只在 DSH profile 内解析——脱离 profile 的独立 `pnpm add github:NelsonLongxiang/dsh-taste-loop` 可能在 typecheck 失败。

## 配置（`cordis.patch.yml`）

```yaml
- id: taste-loop
  config:
    verifierRepo: 'D:erifier仓路径'        # 必填
    inboxHome: 'D:inbox路径'               # 可选
    host: 127.0.0.1                         # taste-mcp HTTP 面
    port: 9810
    arbiterSessionIds: []                   # 允许裁决分歧的 DSH session ID
```

## 开发

```bash
pnpm install && pnpm build && pnpm verify && pnpm drift
```

## 许可

[MIT](./LICENSE)
