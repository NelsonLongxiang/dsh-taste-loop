/**
 * DSH 原生工具面：四件（taste_rules/case/record/queue），与 HTTP 面共用 mcp-core。
 * 身份取自 exec.agent（会话即独立上下文来源——与网关 mcp/<名> 语义互补，均入验证器统计层）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { callTool, INSTRUCTIONS, type CoreDeps, type ToolName } from "./mcp-core.js";

interface ExecLike { agent?: { label?: string; name?: string; title?: string; id?: string } }
const identity = (exec: ExecLike): string => {
  const a = exec.agent;
  const who = a?.label ?? a?.name ?? a?.title ?? a?.id ?? "dsh-session";
  return String(who);
};
const asText = (_args: unknown, value: string): Array<{ type: "text"; text: string }> => [{ type: "text", text: value }];

export function registerTasteTools(ctx: Context, deps: CoreDeps): void {
  const run = (name: ToolName, args: Record<string, unknown>, exec: ExecLike): string =>
    JSON.stringify(callTool(name, args, identity(exec), deps), null, 2);

  ctx.tools.register(defineTool({
    name: "taste_rules",
    description: "品味闭环·动手前先调：返回品味规则。ratified=true 为已认定规则（可当规则执行）；其余是候选（只能参考，遇到判断点仍要 taste_record）。全 false 时按业务现有规范做事。" + INSTRUCTIONS,
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
      rule: { type: "string", required: true, description: "规则 id，必须已登记（见 taste_rules）" },
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
    name: "taste_queue",
    description: "品味闭环·只有人能处理的事项：待仲裁分歧、到期业务结算、结算为假待推翻、各规则认定状态。",
    parameters: {},
    output: { schema: { type: "string" }, render: asText },
    async execute(args: Record<string, unknown>, exec: ExecLike) { return run("queue", args, exec); },
  }));
}
