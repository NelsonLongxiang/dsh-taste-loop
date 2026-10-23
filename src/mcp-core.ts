/**
 * 品味闭环核心（move-not-rewrite 自 ygl-trees 验证器仓 services/taste-mcp/server.mjs 提炼）。
 * 纯逻辑 + 可注入依赖（规则/队列读取、引擎调用），双实现同源由 scripts/check-drift.mjs 防漂移。
 * 引擎调用带孤儿空锁重试（1919cfb 同款缓解：Windows 快速连发下空 .ygllock 残尸误判活锁）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const CLIENT_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
export const MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
// 语法分隔符不得出现在字段里：分号分隔键值、:: 分隔理由、] 结束前缀、换行破坏单行记录
export const FORBIDDEN = /[;\]\r\n]|::/;

export const INSTRUCTIONS = [
  "品味协议（连接本服务即生效）：",
  "1) 动手前先调 rules：ratified=true 的已认定规则才当规则执行；全为 false 时按业务现有规范做事，遇到判断点照常 record。",
  "2) 遇到『两种都说得通、取决于业务口味而非对错』的判断点：先用 case 生成确定性案例 id（同一判断点永远同 id），再调 record 记一条判断，然后继续原工作、不要停下等回复。",
  "3) 诚实声明上下文：作答前看过别人的判断或既有裁决的，record 的 ctx 必须以 decision: 开头（不计独立来源）；没看过就不写或写实际读过的材料。",
  "4) 你不裁决：不冒充 arbiter（仲裁只能由人做）；不要求改已认定规则的措辞——觉得规则不对就记一条相反判断并写清理由，交给人。",
  "5) 不写姓名与业务敏感数据：judge/arbiter 只用会话与模型身份或角色词，case 与理由只写定位和语义。",
  "6) 交付说明里列出本轮全部判断点：case id · rule · verdict · ctx，以及你不确定的地方——不要把不确定写成确定。",
].join("\n");

export const INBOX_PROJECT = { name: "taste-inbox", question: "taste-mcp 收件：经 MCP 网关记录的 agent 品味判断" };

export interface TasteRule { rule_id: string; domain: string; clause: string; selected?: string }
export interface QueueLike { round?: string | null; rules?: Array<{ rule_id: string; ratified?: boolean; blocked_by?: string[] }>; arbitrate?: unknown[]; settle?: unknown[] }

export interface CoreDeps {
  rulesPath: string;
  queuePath: string;
  inboxHome: string;
  enginePath?: string;
}
export function defaultEnginePath(): string {
  const req = createRequire(import.meta.url);
  const pkg = req.resolve("ygl-trees/package.json") as string;
  return join(pkg, "..", "dist", "bundle", "bin.cjs");
}

export class ToolError extends Error {}
const need = (args: Record<string, unknown>, keys: string[]): void => {
  const missing = keys.filter((k) => typeof args?.[k] !== "string" || !(args[k] as string).trim());
  if (missing.length) throw new ToolError(`缺少必填字段：${missing.join(", ")}`);
};
export const clean = (field: string, v: unknown): string => {
  const s = String(v).trim();
  if (FORBIDDEN.test(s)) throw new ToolError(`字段 ${field} 不能包含分号、「]」、「::」或换行（会破坏记录语法）`);
  return s;
};
export const slug = (s: unknown): string =>
  String(s).trim().toLowerCase().replace(/[\s_/\\]+/g, "-").replace(/[^\p{L}\p{N}.-]+/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "");

const loadRules = (p: string): TasteRule[] => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as TasteRule[] : []);
const loadQueue = (p: string): QueueLike | null => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as QueueLike : null);

/** 孤儿空锁重试（1919cfb 缓解）：锁目录存在但为空（无 pid/cmd = 确证无主残尸）时清掉重试一次。 */
function clearOrphanLock(home: string): void {
  const lockDir = join(home, "ygl-trees.db.lock");
  try {
    if (existsSync(lockDir) && readdirSync(lockDir).length === 0) rmSync(lockDir, { recursive: true });
  } catch { /* best effort */ }
}
export function engineRun(enginePath: string, args: string[], home: string): { rc: number; parsed: unknown; out: string } {
  const env = { ...process.env, YGL_HOME: home, YGL_NO_UPDATE_CHECK: "1" };
  const run = () => spawnSync(process.execPath, [enginePath, ...args, "--json"], { encoding: "utf8", env, cwd: process.cwd() });
  let r = run();
  if ((r.status ?? 1) !== 0 && /database is locked/.test((r.stdout ?? "") + (r.stderr ?? ""))) {
    clearOrphanLock(home);
    r = run();
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(String(r.stdout ?? "").trim()); } catch { /* non-JSON stays null */ }
  return { rc: r.status ?? 1, parsed: parsed as never, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function ensureInbox(deps: CoreDeps): string {
  const home = resolve(deps.inboxHome);
  mkdirSync(home, { recursive: true });
  const engine = deps.enginePath ?? defaultEnginePath();
  if (!existsSync(join(home, "ygl-trees.db"))) {
    spawnSync(process.execPath, [engine, "db", "init"], { encoding: "utf8", env: { ...process.env, YGL_HOME: home, YGL_NO_UPDATE_CHECK: "1" } });
    if (!existsSync(join(home, "ygl-trees.db"))) throw new Error(`inbox db init failed under ${home}`);
  }
  const list = engineRun(engine, ["project", "list"], home);
  const names = Array.isArray(list.parsed) ? (list.parsed as Array<{ name?: string }>).map((p) => p.name) : [];
  if (!names.includes(INBOX_PROJECT.name)) {
    const p = engineRun(engine, ["project", "new", INBOX_PROJECT.name, "-q", INBOX_PROJECT.question], home);
    if (p.rc !== 0) throw new Error(`inbox project new failed: ${p.out.slice(0, 200)}`);
  } else {
    engineRun(engine, ["project", "use", INBOX_PROJECT.name], home);
  }
  return home;
}

export type ToolName = "rules" | "case" | "record" | "queue";
export function callTool(name: ToolName, args: Record<string, unknown>, client: string, deps: CoreDeps): unknown {
  switch (name) {
    case "rules": {
      const q = loadQueue(deps.queuePath);
      const status = new Map((q?.rules ?? []).map((r) => [r.rule_id, r]));
      const rules = loadRules(deps.rulesPath)
        .filter((r) => !args?.domain || r.domain === args.domain)
        .map((r) => ({ rule_id: r.rule_id, domain: r.domain, clause: r.clause, selected: r.selected, ratified: status.get(r.rule_id)?.ratified === true, blocked_by: status.get(r.rule_id)?.blocked_by ?? [] }));
      return { as_of_round: q?.round ?? null, ratified: rules.filter((r) => r.ratified).length, rules, note: rules.some((r) => r.ratified) ? "只把 ratified 的规则当规则用" : "目前没有已认定规则：按业务现有规范做事，判断点照常 record" };
    }
    case "case": {
      need(args, ["object", "position"]);
      const id = `${slug(args.object)}-${slug(args.position)}`;
      if (!id.replace(/-/g, "")) throw new ToolError("object / position 规范化后为空");
      return { case_id: id };
    }
    case "record": {
      need(args, ["domain", "case", "rule", "verdict", "anchor", "reason", "model"]);
      const f: Record<string, string> = {};
      for (const k of ["domain", "case", "rule", "verdict", "anchor", "reason", "model", "ctx", "layer"]) {
        if (args[k] != null && String(args[k]).trim()) f[k] = clean(k, args[k]);
      }
      if (!MODEL_RE.test(f.model)) throw new ToolError("model 只能含字母、数字和 . _ : / -");
      if (f.layer && !/^L[0-4]$/.test(f.layer)) throw new ToolError("layer 只能是 L0–L4");
      const rule = loadRules(deps.rulesPath).find((r) => r.rule_id === f.rule);
      if (!rule) throw new ToolError(`规则 ${f.rule} 未登记：先请人登记规则，或用 rules 查已有规则`);
      if (rule.domain !== f.domain) throw new ToolError(`规则 ${f.rule} 属于域「${rule.domain}」，与 domain「${f.domain}」不一致`);
      if (!CLIENT_RE.test(client)) throw new ToolError("调用方身份缺失或非法");
      const judge = `agent:${client}@${f.model}`;
      const parts = [`case=${f.case}`, `rule=${f.rule}`, `verdict=${f.verdict}`, `judge=${judge}`, `anchor=${f.anchor}`];
      if (f.ctx) parts.push(`ctx=${f.ctx}`);
      if (f.layer) parts.push(`layer=${f.layer}`);
      const text = `[品味·${f.domain}] ${parts.join("; ")} :: ${f.reason}`;
      const home = ensureInbox(deps);
      const engine = deps.enginePath ?? defaultEnginePath();
      const r = engineRun(engine, ["research", "claim", "add", text, "--confidence", "B"], home);
      const rec = r.parsed as { id?: string; duplicate?: boolean } | null;
      if (r.rc !== 0 || !rec?.id) throw new Error(`写入失败：${r.out.slice(0, 200)}`);
      return { claim_id: rec.id, duplicate: rec.duplicate === true, judge, model_self_reported: true, text };
    }
    case "queue": {
      const q = loadQueue(deps.queuePath);
      if (!q) return { round: null, note: "还没有跑过一轮验证（work/human-queue.json 不存在）" };
      return { round: q.round, arbitrate: q.arbitrate ?? [], settle: q.settle ?? [], rules: q.rules ?? [], source_problems: [] };
    }
    default:
      throw new ToolError(`未知工具: ${name}`);
  }
}
