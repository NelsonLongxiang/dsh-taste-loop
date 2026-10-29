/**
 * 品味闭环核心（move-not-rewrite 自 ygl-trees 验证器仓 services/taste-mcp/server.mjs 提炼）。
 * 纯逻辑 + 可注入依赖（规则/队列读取、引擎调用），双实现同源由 scripts/check-drift.mjs 防漂移。
 * 引擎调用带孤儿空锁重试（1919cfb 同款缓解：Windows 快速连发下空 .ygllock 残尸误判活锁）。
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

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

export interface TasteRule { rule_id: string; domain: string; clause: string; selected?: string; candidates?: string | string[] }
const parseCandidates=(raw?:string|string[]):string[]|undefined=>{if(!raw)return undefined;if(Array.isArray(raw))return raw;try{const x=JSON.parse(raw);return Array.isArray(x)?x.filter((v):v is string=>typeof v==="string"):undefined}catch{return undefined}};
export interface QueueLike { round?: string | null; rules?: Array<{ rule_id: string; ratified?: boolean; blocked_by?: string[] }>; arbitrate?: unknown[]; settle?: unknown[] }

export interface CoreDeps {
  rulesPath: string;
  queuePath: string;
  inboxHome: string;
  proposalsPath?: string;
  endorsementsPath?: string;
  resolutionsPath?: string;
  arbiterSessionIds?: string[];
  enginePath?: string;
}
export function defaultEnginePath(): string {
  const req = createRequire(import.meta.url);
  let dir = dirname(req.resolve("ygl-trees"));
  while (dir !== dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        if ((JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "ygl-trees") {
          const bin = join(dir, "dist", "bundle", "bin.cjs");
          if (existsSync(bin)) return bin;
        }
      } catch { /* keep walking */ }
    }
    dir = dirname(dir);
  }
  throw new Error("无法定位 ygl-trees/dist/bundle/bin.cjs");
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

export type ToolName = "rules" | "case" | "record" | "queue" | "update";

export interface RuleProposal { proposal_id:string; revision:number; rule_id:string; domain:string; case:string; clause:string; candidates:string[]; selected:string; reason:string; anchor:string; author:string; author_session?:string; resolved_by?:string; author_model:string; model:string; ctx?:string; proposed_at:string; status:"pending_review"|"active"|"needs_arbitration"|"rejected"; effective:boolean; independent:Record<string,string[]>; version:string; duplicate?:boolean }
function readProposals(path:string): RuleProposal[] { if (!existsSync(path)) return []; return readFileSync(path,"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as RuleProposal); }
interface Endorsement { proposal_id:string; revision:number; case:string; verdict:string; judge:string; session:string; ctx?:string; claim_id:string; at:string }
interface Resolution { proposal_id:string; revision:number; verdict:string; disposition:"accept"|"reject"; session:string; reason:string; claim_id:string; at:string }
function readEndorsements(path?:string):Endorsement[]{if(!path||!existsSync(path))return [];return readFileSync(path,"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as Endorsement)}
function readResolutions(path?:string):Resolution[]{if(!path||!existsSync(path))return [];return readFileSync(path,"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as Resolution)}
const sha = (s:string):string => createHash("sha256").update(s).digest("hex");
function withLedgerLock<T>(ledgerPath:string,fn:()=>T):T {
 const lock=ledgerPath+".lock";mkdirSync(dirname(ledgerPath),{recursive:true});const deadline=Date.now()+5000;let fd:number|undefined;
 while(fd===undefined){try{fd=openSync(lock,"wx");}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;if(Date.now()>=deadline)throw new ToolError("品味提案正在被其他会话修改；稍后重试，未写入数据");Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}}
 try{return fn();}finally{try{closeSync(fd);unlinkSync(lock);}catch{/* best effort release */}}
}
const verifiedSession = (client:string):string|undefined => client.startsWith("dsh-session:") ? client.slice("dsh-session:".length) : undefined;
export function proposalStatus(p:RuleProposal,votes:Endorsement[]):{status:RuleProposal["status"];effective:boolean;independent:Record<string,string[]>} {
 const relevant=votes.filter(v=>v.proposal_id===p.proposal_id&&v.revision===p.revision&&!v.ctx?.startsWith("decision:")&&(!p.author_session||v.session!==p.author_session));
 const independent:Record<string,string[]>={}; for(const v of relevant)(independent[v.verdict]??=[]).push(v.session);
 for(const verdict of Object.keys(independent)) independent[verdict]=[...new Set(independent[verdict])];
 const dissentSessions=new Set(Object.entries(independent).filter(([v])=>v!==p.selected).flatMap(([,sessions])=>sessions));
 const dissent=dissentSessions.size;
 const count=independent[p.selected]?.length??0;
 const quorum=p.author_session?2:Number.POSITIVE_INFINITY; // unknown gateway proposer cannot auto-activate without authenticated creator session
 if(dissent>=2)return {status:"needs_arbitration",effective:false,independent};
 if(count>=quorum)return {status:"active",effective:true,independent};
 return {status:"pending_review",effective:false,independent};
}
export function proposeRule(args:Record<string,unknown>,client:string,deps:CoreDeps):RuleProposal {
  need(args,["domain","rule_id","case","clause","selected","reason","anchor","model"]);
  const cleanFields=(key:string)=>clean(key,args[key]);
  const domain=cleanFields("domain"), ruleId=cleanFields("rule_id"), caseId=cleanFields("case"), clause=cleanFields("clause"), selected=cleanFields("selected"), reason=cleanFields("reason"), anchor=cleanFields("anchor"), model=cleanFields("model");
  if(!MODEL_RE.test(model)) throw new ToolError("model 只能含字母、数字和 . _ : / -");
  if(!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(ruleId)) throw new ToolError("rule_id 必须是稳定的大写字母/数字/连字符标识");
  if(!CLIENT_RE.test(client)) throw new ToolError("调用方身份缺失或非法");
  const sessionId=verifiedSession(client);
  if(!sessionId) throw new ToolError("规则提案需要可信 DSH session ID；HTTP 网关客户端身份未经验证，仅可写普通判断，不可提出共享规则");
  const raw=args.candidates; if(!Array.isArray(raw)||raw.length<2||raw.some(x=>typeof x!=="string"||!x.trim())) throw new ToolError("candidates 至少包含两个非空候选");
  const candidates=raw.map((x,i)=>clean("candidates["+i+"]",x)); if(!candidates.includes(selected)) throw new ToolError("selected 必须是 candidates 之一");
  const existing=loadRules(deps.rulesPath).find(r=>r.rule_id===ruleId); if(existing&&existing.domain!==domain) throw new ToolError("该 rule_id 已属于其他域，不能跨域接管");
  const path=deps.proposalsPath ?? join(dirname(deps.rulesPath),"..","work","taste-rule-proposals.jsonl");
  return withLedgerLock(path,()=>{
  if(readProposals(path).some(p=>p.rule_id===ruleId&&p.domain!==domain)) throw new ToolError("该 rule_id 已有其他域提案，不能跨域接管");
  const proposalId=clean("proposal_id",String(args.proposal_id||slug(domain)+"--"+ruleId));
  const allHistory=readProposals(path);
  const priorDomainHistory=allHistory.filter(p=>p.rule_id===ruleId&&p.domain===domain);
  const statusView=proposalView(path,readEndorsements(deps.endorsementsPath),true,readResolutions(deps.resolutionsPath));
  const unresolvedDomain=priorDomainHistory.some(p=>statusView.latest.find(x=>x.proposal_id===p.proposal_id)?.status==="needs_arbitration");
  if(unresolvedDomain)throw new ToolError("该 rule_id 在本域存在未解决的仲裁；不能用新 proposal_id 绕过");
  const rejectedIds=new Set(readResolutions(deps.resolutionsPath).filter(r=>r.disposition==="reject").map(r=>r.proposal_id));
  if(rejectedIds.has(proposalId))throw new ToolError("该 proposal ID 已被 human resolver 拒绝；请新建 proposal ID");
  if(!args.proposal_id&&allHistory.some(p=>p.rule_id===ruleId&&p.domain===domain&&p.proposal_id!==proposalId))throw new ToolError("该规则已有其他 proposal_id；修订需复用已有 proposal_id");
  const history=allHistory.filter(p=>p.proposal_id===proposalId).sort((a,b)=>b.revision-a.revision);
  const prior=history[0];
  if(args.proposal_id&&!prior) throw new ToolError("proposal_id 不存在；新提案请省略 proposal_id");
  const existingVotes=readEndorsements(deps.endorsementsPath);
  const existingResolutions=readResolutions(deps.resolutionsPath);
  const last=history[0];
  const latestState=proposalView(path,existingVotes,true,existingResolutions).latest.find(p=>p.proposal_id===proposalId);
  const unresolved=latestState?.status==="needs_arbitration";
  if(unresolved) throw new ToolError("该规则有未解决的独立分歧；先由配置的 human resolver 仲裁后才能开新修订");
  const lastResolution=last&&existingResolutions.find(r=>r.proposal_id===last.proposal_id&&r.revision===last.revision);
  if(lastResolution?.disposition==="reject"&&args.proposal_id)throw new ToolError("该 proposal ID 已被 human resolver 拒绝；请使用新 proposal ID 提出新规则");
  if(prior&&(prior.domain!==domain||prior.rule_id!==ruleId)) throw new ToolError("修订不能更换 proposal 的域或 rule_id");
  const ctx=typeof args.ctx==="string"&&args.ctx.trim()?clean("ctx",args.ctx):undefined;
  const fingerprint=JSON.stringify({case:caseId,clause,candidates,selected,reason,anchor,ctx});
  if(prior&&prior.author==="agent:"+client+"@"+model&&JSON.stringify({case:prior.case,clause:prior.clause,candidates:prior.candidates,selected:prior.selected,reason:prior.reason,anchor:prior.anchor,ctx:prior.ctx})===fingerprint) return {...prior,duplicate:true};
  const event:RuleProposal={proposal_id:proposalId,revision:(prior?.revision??0)+1,rule_id:ruleId,domain,clause,candidates,selected,reason,case:caseId,anchor,author:"agent:"+client+"@"+model,...(sessionId?{author_session:sessionId}:{}),author_model:model,model,...(ctx?{ctx}:{}),proposed_at:new Date().toISOString(),status:"pending_review",effective:false,independent:{},version:"sha256:"+sha(JSON.stringify({ruleId,domain,case:caseId,clause,candidates,selected,reason,anchor,ctx}))};
  appendFileSync(path,JSON.stringify(event)+"\n",{encoding:"utf8",flag:"a"}); return event;
  });
}
function proposalView(path?:string,votes:Endorsement[]=[],includeAuthorDetails=true,resolutions:Resolution[]=[]):{latest:RuleProposal[];active:RuleProposal[];history_count:number}{
 if(!path||!existsSync(path))return {latest:[],active:[],history_count:0};
 const all=readProposals(path),latest=new Map<string,RuleProposal>();
 for(const p of all){const old=latest.get(p.proposal_id);if(!old||p.revision>old.revision)latest.set(p.proposal_id,p);}
 const decorate=(p:RuleProposal):RuleProposal=>{
  const row={...p,...proposalStatus(p,votes)};const resolution=resolutions.find(r=>r.proposal_id===p.proposal_id&&r.revision===p.revision);
  const resolved:RuleProposal&{resolved_by?:string}=resolution?{...row,selected:resolution.disposition==="reject"?"__rejected__":resolution.verdict,status:resolution.disposition==="accept"?"active":"rejected",effective:resolution.disposition==="accept",resolved_by:resolution.session}:row;
  if(includeAuthorDetails)return resolved;
  return {...resolved,selected:"[blind]",reason:"[blind]",author:"[blind]",author_model:"[blind]",author_session:undefined,ctx:undefined,independent:{},status:"pending_review",effective:false,resolved_by:undefined};
 };
 const latestRows=[...latest.values()].map(decorate);
 const activeRows=all.map(decorate).filter(p=>p.effective);
 const resolved=new Map(resolutions.map(r=>[r.proposal_id+"@"+r.revision,r]));
 const unresolvedIds=new Set(all.filter(p=>!resolved.has(p.proposal_id+"@"+p.revision)&&proposalStatus(p,votes).status==="needs_arbitration").map(p=>p.proposal_id));
 for(const p of latestRows)if(unresolvedIds.has(p.proposal_id)&&p.status!=="needs_arbitration"){p.status="needs_arbitration";p.effective=false;}
 const unresolvedActive=new Set([...unresolvedIds].map(id=>latest.get(id)?.rule_id).filter(Boolean));
 return {latest:latestRows,active:activeRows.filter(p=>!unresolvedActive.has(p.rule_id)),history_count:all.length};
}
function resolveProposal(args:Record<string,unknown>,client:string,deps:CoreDeps):unknown {
 const session=client.startsWith("dsh-session:")?client.slice("dsh-session:".length):undefined;
 if(!session||client.startsWith("mcp/")||!deps.arbiterSessionIds?.includes(session))throw new ToolError("当前会话不在配置的 arbiter session allowlist 中；resolution denied");
 need(args,["proposal_id","verdict","disposition","reason"]);
 const pp=deps.proposalsPath??join(dirname(deps.rulesPath),"..","work","taste-rule-proposals.jsonl");
 const id=clean("proposal_id",args.proposal_id),revision=Number(args.revision);if(!Number.isInteger(revision)||revision<1)throw new ToolError("revision 必须是正整数");const p=readProposals(pp).find(x=>x.proposal_id===id&&x.revision===revision);
 if(!p)throw new ToolError("提案版本不存在");
 const verdict=clean("verdict",args.verdict),disposition=clean("disposition",args.disposition);if(disposition!=="accept"&&disposition!=="reject")throw new ToolError("disposition must be accept or reject");if(disposition==="accept"&&!p.candidates.includes(verdict))throw new ToolError("accepted verdict must be one of proposal candidates");if(disposition==="reject"&&verdict!=="__rejected__")throw new ToolError("rejected proposal must use verdict __rejected__");
 const reason=clean("reason",args.reason);const path=deps.resolutionsPath??join(dirname(pp),"taste-rule-resolutions.jsonl");mkdirSync(dirname(path),{recursive:true});
 const resolutions=readResolutions(path);const prior=resolutions.find(x=>x.proposal_id===id&&x.revision===revision);
 if(prior&&prior.session!==session)throw new ToolError("此 proposal revision 已由另一 resolver 处理");
 if(prior)return {...prior,duplicate:true};
 const home=ensureInbox(deps),engine=deps.enginePath??defaultEnginePath();
 const text="[品味仲裁] case="+p.case+"; rule="+p.rule_id+"; verdict="+verdict+"; disposition="+disposition+"; judge=human-session:"+session+"; proposal="+id+"@"+revision+" :: "+reason;
 const written=engineRun(engine,["research","claim","add",text,"--confidence","A"],home),claim=written.parsed as {id?:string}|null;
 if(written.rc!==0||!claim?.id)throw new Error("仲裁决定写入失败："+written.out.slice(0,200));
 const row:Resolution={proposal_id:id,revision,verdict,disposition:disposition as "accept"|"reject",session,reason,claim_id:claim.id,at:new Date().toISOString()};appendFileSync(path,JSON.stringify(row)+"\n",{encoding:"utf8",flag:"a"});
 return {...row,active:proposalView(pp,readEndorsements(deps.endorsementsPath),true,readResolutions(path)).active.some(x=>x.proposal_id===id&&x.revision===revision)};
}
function endorseProposal(args:Record<string,unknown>,client:string,deps:CoreDeps):unknown {
  need(args,["proposal_id","case","verdict","anchor","reason","model"]);
  const pp=deps.proposalsPath??join(dirname(deps.rulesPath),"..","work","taste-rule-proposals.jsonl");
  const proposalId=clean("proposal_id",args.proposal_id);const epPath=deps.endorsementsPath??join(dirname(pp),"taste-rule-endorsements.jsonl");
  return withLedgerLock(epPath,()=>{
  const revisions=readProposals(pp).filter(x=>x.proposal_id===proposalId).sort((a,b)=>b.revision-a.revision);const p=revisions[0];if(!p)throw new ToolError("proposal 不存在");if(Number(args.revision)!==p.revision)throw new ToolError("提案版本已变化；请重新读取最新版本再背书");
  const model=clean("model",args.model),ctx=typeof args.ctx==="string"&&args.ctx.trim()?clean("ctx",args.ctx):undefined,verdict=clean("verdict",args.verdict);
  if(!MODEL_RE.test(model)||!CLIENT_RE.test(client))throw new ToolError("model 或调用方身份非法");if(!p.candidates.includes(verdict))throw new ToolError("verdict 必须属于提案候选");
  const sessionId=verifiedSession(client);
  if(!sessionId)throw new ToolError("独立背书需要可验证的 DSH agent session ID；共享网关身份不足以计独立来源");
  const caseId=clean("case",args.case);if(caseId!==p.case)throw new ToolError("背书必须沿用提案确定性 case");
  if(p.author_session&&sessionId===p.author_session)throw new ToolError("提案作者的判断须用 taste_record 记录；独立背书须来自其他会话");
  const judge="agent:"+client+"@"+model,anchor=clean("anchor",args.anchor),reason=clean("reason",args.reason);
  const parts=["case="+caseId,"rule="+p.rule_id,"verdict="+verdict,"judge="+judge,"anchor="+anchor,"proposal="+proposalId+"@"+p.revision];if(ctx)parts.push("ctx="+ctx);
  const text="[品味·"+p.domain+"] "+parts.join("; ")+" :: "+reason;
  const ep=epPath;mkdirSync(dirname(ep),{recursive:true});
  const existing=readEndorsements(ep).find(x=>x.proposal_id===proposalId&&x.revision===p.revision&&x.session===sessionId&&x.verdict===verdict&&x.case===caseId);
  if(existing){const state=proposalView(pp,readEndorsements(ep)).latest.find(x=>x.proposal_id===proposalId);return {claim_id:existing.claim_id,duplicate:true,proposal_id:proposalId,revision:p.revision,status:state?.status,effective:state?.effective,independent:state?.independent};}
  const home=ensureInbox(deps),engine=deps.enginePath??defaultEnginePath();
  const wr=engineRun(engine,["research","claim","add",text,"--confidence","B"],home),claim=wr.parsed as {id?:string}|null;if(wr.rc!==0||!claim?.id)throw new Error("写入失败："+wr.out.slice(0,200));
  const endorsement:Endorsement={proposal_id:proposalId,revision:p.revision,case:caseId,verdict,judge,session:sessionId,...(ctx?{ctx}:{}),claim_id:claim.id,at:new Date().toISOString()};appendFileSync(ep,JSON.stringify(endorsement)+"\n",{encoding:"utf8",flag:"a"});
  const votes=readEndorsements(ep);const state=proposalView(pp,votes).latest.find(x=>x.proposal_id===proposalId);return {claim_id:claim.id,proposal_id:proposalId,revision:p.revision,status:state?.status,effective:state?.effective,independent:state?.independent};
  });
}
export function callTool(name: ToolName, args: Record<string, unknown>, client: string, deps: CoreDeps): unknown {
  switch (name) {
    case "rules": {
      const q = loadQueue(deps.queuePath);
      const status = new Map((q?.rules ?? []).map((r) => [r.rule_id, r]));
      const proposalState=proposalView(deps.proposalsPath,readEndorsements(deps.endorsementsPath),true,readResolutions(deps.resolutionsPath));
      const activeByRule=new Map(proposalState.active.map(p=>[p.rule_id,p]));
      const baseRules=loadRules(deps.rulesPath).filter(r=>!args?.domain||r.domain===args.domain);
      const rules=baseRules.map(r=>{const active=activeByRule.get(r.rule_id);const st=status.get(r.rule_id);return {rule_id:r.rule_id,domain:r.domain,clause:active?.clause??r.clause,selected:active?.selected??r.selected,ratified:st?.ratified===true,effective:st?.ratified===true||Boolean(active),blocked_by:(st?.ratified===true||active)?[]:(st?.blocked_by??[]),...(active?{source:"proposal-consensus",proposal_id:active.proposal_id,revision:active.revision,version:active.version}:{})};});
      for(const active of activeByRule.values())if((!args?.domain||args.domain===active.domain)&&!baseRules.some(r=>r.rule_id===active.rule_id))rules.push({rule_id:active.rule_id,domain:active.domain,clause:active.clause,selected:active.selected,ratified:false,effective:true,blocked_by:[],source:"proposal-consensus",proposal_id:active.proposal_id,revision:active.revision,version:active.version});
      const proposals=proposalState.latest.filter(p=>!args?.domain||p.domain===args.domain);
      return { as_of_round: q?.round ?? null, ratified: rules.filter((r) => r.ratified).length, rules, proposals, proposal_history_count:proposalState.history_count, note: rules.some((r) => r.ratified) ? "human ratified 与 active 域共识版本都可指导工作；pending 为候选，needs_arbitration 等人裁" : "目前没有已认定规则：按业务现有规范做事；agent 可自助维护 proposals；两独立会话同向可 active，反向意见进入 needs_arbitration" };
    }
    case "update": {
      const action=String(args.action??"propose");
      const votes=readEndorsements(deps.endorsementsPath);
      if(action==="list") return proposalView(deps.proposalsPath,votes,true,readResolutions(deps.resolutionsPath));
      if(action==="blind") { const state=proposalView(deps.proposalsPath,votes,false,readResolutions(deps.resolutionsPath)); const proposalId=typeof args.proposal_id==="string"?args.proposal_id:""; return { ...state, latest:state.latest.filter(p=>p.proposal_id===proposalId), note:"Blind review view: proposer’s selected verdict/reason/context and outcome are hidden." }; }
      if(action==="propose") return proposeRule(args,client,deps);
      if(action==="endorse") return endorseProposal(args,client,deps);
      if(action==="resolve") return resolveProposal(args,client,deps);
      throw new ToolError("仅支持 propose/list/blind/endorse/resolve；resolution 仅允许 arbiterSessionIds 中的 DSH session");
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
      const activeRules=proposalView(deps.proposalsPath,readEndorsements(deps.endorsementsPath),true,readResolutions(deps.resolutionsPath));
      const activeProposal=activeRules.active.filter(p=>p.rule_id===f.rule&&p.domain===f.domain).sort((a,b)=>b.revision-a.revision)[0];
      const rule = loadRules(deps.rulesPath).find((r) => r.rule_id === f.rule);
      const newestProposal=activeRules.latest.filter(p=>p.rule_id===f.rule&&p.domain===f.domain&&p.status!=="needs_arbitration").sort((a,b)=>b.revision-a.revision)[0];
      const proposal = activeProposal ?? (!rule ? newestProposal : undefined);
      if (!rule && !proposal) throw new ToolError(`规则 ${f.rule} 未登记：请先 taste_update propose 新建提案`);
      if (rule && rule.domain !== f.domain) throw new ToolError(`规则 ${f.rule} 属于域「${rule.domain}」，与 domain「${f.domain}」不一致`);
      const candidates=activeProposal?.candidates??(rule?parseCandidates(rule.candidates):(proposal?.status==="active"?proposal.candidates:undefined));
      if(candidates&& !candidates.includes(f.verdict))throw new ToolError(`判断 ${f.verdict} 不在有效规则候选集中`);
      if(!rule&&proposal?.status==="needs_arbitration")throw new ToolError("该提案存在分歧，仲裁完成前不能继续用它记录");
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
      const ruleProposals=proposalView(deps.proposalsPath,readEndorsements(deps.endorsementsPath),true,readResolutions(deps.resolutionsPath)).latest;
      const needsArbitration=ruleProposals.filter(p=>p.status==="needs_arbitration");
      const rejected=ruleProposals.filter(p=>p.status==="rejected");
      if (!q) return { round: null, arbitrate: [], settle: [], rules: [], rule_proposals:needsArbitration, rejected_proposals:rejected, note: "还没有跑过验证轮；rule_proposals 列出待人仲裁提案" };
      return { round: q.round, arbitrate: q.arbitrate ?? [], settle: q.settle ?? [], rules: q.rules ?? [], rule_proposals:needsArbitration, rejected_proposals:rejected, source_problems: [] };
    }
    default:
      throw new ToolError(`未知工具: ${name}`);
  }
}
