# @nelsonlongxiang/dsh-taste-loop

品味闭环 DSH 插件（host-only）：`taste_rules / taste_case / taste_record / taste_queue` 四工具 + taste-mcp StreamableHTTP 服务托管（供工作台市场网关聚合为 `taste__*`）+ 协议经工具描述与 systemPrompt 段自呈现。

- 设计稿：ygl-taste-pilot-verifier `docs/PLUGIN-DESIGN.md`（评审裁定见其 issue #7）
- 核心与验证器仓 `services/taste-mcp/server.mjs` 双实现同源（`pnpm drift` 防漂移）
- 引擎自包含（ygl-trees 0.114.9 钉版，带空锁残尸重试缓解）
- 配置：`verifierRepo`（必填）、`inboxHome/host/port/toolsEnabled/httpEnabled`
- 边界：不提供仲裁、改规则、跑判定——裁决是人的，判定只出自 verify run

## 开发

```bash
pnpm install && pnpm build && pnpm verify && pnpm drift
```
