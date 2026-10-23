/**
 * @nelsonlongxiang/dsh-taste-loop — 品味闭环 DSH 插件（host-only）。
 * 贡献：taste_rules/case/record/queue 四工具 + taste-mcp StreamableHTTP 服务（供市场网关聚合）
 *      + systemPrompt 协议段。生命周期归 fiber（ctx.effect）；不提供仲裁/改规则/跑判定。
 * v1 形态注记：按设计稿 §4 以「函数插件 + effect 所有权」实现生命周期托管（与 Service 等价的最小面），
 * 待出现跨插件消费方再升格 Service（YAGNI）。
 */
import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { join, resolve } from "node:path";
import type { CoreDeps } from "./mcp-core.js";
import { ensureInbox, INSTRUCTIONS } from "./mcp-core.js";
import { registerTasteTools } from "./tools.js";
import { startTasteHttp } from "./http-face.js";

export const name = "taste-loop";
export const inject = ["tools", "systemPrompt"];

export interface Config {
  verifierRepo: string;
  inboxHome?: string;
  host?: string;
  port?: number;
  toolsEnabled?: boolean;
  httpEnabled?: boolean;
}
export const Config: z<Config> = z.object({
  verifierRepo: z.string().description("ygl-taste-pilot-verifier 仓路径（rules.json / human-queue.json 读取源）"),
  inboxHome: z.string().description("收件工作区（默认 <verifierRepo>/state/inbox）"),
  host: z.string().default("127.0.0.1").description("taste-mcp 监听地址（供市场网关 upstream）"),
  port: z.number().default(9810).description("taste-mcp 监听端口"),
  toolsEnabled: z.boolean().default(true).description("注册 taste_* 四工具"),
  httpEnabled: z.boolean().default(true).description("托管 taste-mcp HTTP 面（市场网关 taste__* 依赖它）"),
});

export function apply(ctx: Context, config: Config): void {
  const repo = resolve(config.verifierRepo);
  const deps: CoreDeps = {
    rulesPath: join(repo, "data", "taste", "rules.json"),
    queuePath: join(repo, "work", "human-queue.json"),
    inboxHome: config.inboxHome ? resolve(config.inboxHome) : join(repo, "state", "inbox"),
  };
  if (config.httpEnabled !== false) {
    ctx.effect(() => {
      let stopped = false;
      let disposeServer: (() => Promise<void>) | null = null;
      void startTasteHttp(config.host ?? "127.0.0.1", config.port ?? 9810, deps)
        .then(({ url, dispose }) => {
          if (stopped) { void dispose(); return; }
          disposeServer = dispose;
          ctx.logger?.info?.(`taste-mcp listening on ${url} · inbox ${deps.inboxHome}`);
        })
        .catch((e: unknown) => { throw new Error(`taste-mcp 启动失败：${(e as Error)?.message ?? e}`); });
      return () => { stopped = true; void disposeServer?.(); };
    }, "taste-loop:http");
  }
  if (config.toolsEnabled !== false) registerTasteTools(ctx, deps);
  if (ctx.systemPrompt) {
    ctx.systemPrompt.section({ name: "taste-loop", order: 900, interpolate: false, text: () => INSTRUCTIONS });
  }
}
