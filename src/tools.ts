/**
 * DSH 原生工具面：四件（taste_rules/case/record/queue），与 HTTP 面共用 mcp-core。
 * 身份取自 exec.agent（会话即独立上下文来源——与网关 mcp/<名> 语义互补，均入验证器统计层）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { callTool, INSTRUCTIONS, type CoreDeps, type ToolName } from "./mcp-core.js";

interface ExecLike { agent?: { id?: string; label?: string; name?: string; title?: string }; rootCallId?: string; callId?: string }
const identity = (exec: ExecLike): string => String(exec.agent?.id ?? exec.agent?.label ?? exec.agent?.name ?? exec.agent?.title ?? "dsh-session");
const sessionIdentity = (exec: ExecLike): string | undefined => exec.agent?.id ? String(exec.agent.id) : undefined;
const asText = (_args: unknown, value: string): Array<{ type: "text"; text: string }> => [{ type: "text", text: value }];

export function registerTasteTools(ctx: Context, deps: CoreDeps): void {
  const run = (name: ToolName, args: Record<string, unknown>, exec: ExecLike): string => {
    const client="dsh-session:"+(name === "update" ? (sessionIdentity(exec)??"") : identity(exec));
    return JSON.stringify(callTool(name, args, client, deps), null, 2);
  };

  ctx.tools.register(defineTool({
    name: "taste_rules",
    description: "品味闭环·动手前先调：返回本域规则/提案。ratified=true 是人工认定；effective=true 是作者外两名独立 DSH session 同向形成的域内当前版本；pending 仅供记录判断，不当成已生效。" + INSTRUCTIONS,
    parameters: { domain: { type: "string", description: "只看某个域（可选）" } },
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("rules", args, exec); },
  }));
  ctx.tools.register(defineTool({
    name: "taste_case",
    description: "品味闭环·生成确定性案例 id：同一对象、同一位置永远同 id——不同 agent 对同一判断点必须用同一 id 才能比对。",
    parameters: { object: { type: "string", required: true, description: "判断的对象，如 mpbs-202612 汇总表 CDH 册" }, position: { type: "string", required: true, description: "对象内的位置，如 r17 / 数据来源列" } },
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("case", args, exec); },
  }));
  ctx.tools.register(defineTool({
    name: "taste_record",
    description: "品味闭环·在『两种都说得通、取决于业务口味』的判断点记一条品味判断，然后继续原工作。身份由会话确认不用填；model 填你的模型 id；作答前看过别人判断或既有裁决的 ctx 必须以 decision: 开头（不计独立来源）。当场校验字段与规则登记。",
    parameters: {
      domain: { type: "string", required: true, description: "域，如 财务汇总·数据来源列" },
      case: { type: "string", required: true, description: "案例 id（用 taste_case 生成）" },
      rule: { type: "string", required: true, description: "规则 id，须在 taste_rules 中已登记或处于有效提案版本" },
      verdict: { type: "string", required: true, description: "你的选择（规则候选里的一个，如 A）" },
      anchor: { type: "string", required: true, description: "依据：条款、文件位置或定义" },
      reason: { type: "string", required: true, description: "一句话理由" },
      model: { type: "string", required: true, description: "你的模型 id（自报，记录里如实标注）" },
      ctx: { type: "string", description: "作答前读过的上下文；看过既有裁决写 decision:<来源>" },
      layer: { type: "string", enum: ["L0", "L1", "L2", "L3", "L4"], description: "可选：L0–L4" },
    },
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("record", args, exec); },
  }));
  ctx.tools.register(defineTool({
    name: "taste_update",
    description: "品味闭环·自助新建/修订本域规则提案；作者外两名独立会话同向后 active，反向独立意见进仲裁；decision 不算独立，历史版本保留。",
    parameters: {
      action: { type: "string", enum: ["propose", "list", "blind", "endorse", "resolve"], description: "propose 创建/修订；blind 盲审题面；endorse 独立判断；resolve 仅配置的 human arbiter session 可处理分歧" },
      proposal_id: { type: "string", description: "endorse 或修订时的提案 ID" },
      revision: { type: "number", description: "endorse/resolve 时使用 proposal 当前版本号" },
      case: { type: "string", description: "同一规则取舍的确定性案例 ID，由 taste_case 生成" },
      verdict: { type: "string", description: "endorse 时的候选判定；resolve 时的仲裁结果" },
      disposition: { type: "string", enum: ["accept", "reject"], description: "resolve 时接受/拒绝提案" },
      domain: { type: "string", description: "规则所属域" },
      rule_id: { type: "string", description: "稳定规则 ID（新提案必填）" },
      clause: { type: "string", description: "规则条款" },
      candidates: { type: "array", items: { type: "string" }, description: "至少两个可选方案" },
      selected: { type: "string", description: "提案方当前选择，必须匹配候选之一" },
      reason: { type: "string", description: "一句话理由" },
      anchor: { type: "string", description: "规范条款、证据或材料位置" },
      model: { type: "string", description: "模型 ID" },
      ctx: { type: "string", description: "作答前读过的裁决标 decision:，非独立源" },
    },
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("update", args, exec); },
  }));
  ctx.tools.register(defineTool({
    name: "taste_queue",
    description: "品味闭环·待人处理队列：独立判断分歧、需仲裁的规则更新、到期结算及认定状态。",
    parameters: {},
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("queue", args, exec); },
  }));
}
