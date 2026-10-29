import { test } from "node:test";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { callTool, clean, slug, INSTRUCTIONS, proposalStatus, defaultEnginePath } from "../lib/mcp-core.js";
const deps = { rulesPath: new URL("./fixtures/rules.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), queuePath: "/nonexistent/queue.json", inboxHome: "/nonexistent/inbox" };
test("clean 拒绝语法分隔符", () => { assert.throws(() => clean("anchor", "a; judge=x")); assert.throws(() => clean("anchor", "a]b")); assert.equal(clean("x", " ok "), "ok"); });
test("slug 确定性", () => { assert.equal(slug("MPBS 2026 汇总表"), slug("mpbs-2026_汇总表")); assert.equal(slug("A/B\\C"), "a-b-c"); });
test("case 生成确定性 id", () => { const r = callTool("case", { object: "P2 网关", position: "r1" }, "mcp/t", deps); assert.equal(r.case_id, "p2-网关-r1"); });
test("record 校验：未登记规则拒绝", () => { assert.throws(() => callTool("record", { domain: "d", case: "c", rule: "NOPE", verdict: "A", anchor: "a", reason: "r", model: "m" }, "mcp/t", deps), /未登记/); });
test("record 校验：域不一致拒绝", () => { assert.throws(() => callTool("record", { domain: "错误域", case: "c", rule: "R1", verdict: "A", anchor: "a", reason: "r", model: "m" }, "mcp/t", deps), /不一致/); });
test("record 校验：非法 model 拒绝", () => { assert.throws(() => callTool("record", { domain: "测试域", case: "c", rule: "R1", verdict: "A", anchor: "a", reason: "r", model: "bad model!" }, "mcp/t", deps), /model/); });
test("rules 读取与 ratified 状态", () => { const r = callTool("rules", {}, "mcp/t", deps); assert.equal(r.rules.length, 1); assert.equal(r.ratified, 0); });
test("queue 未跑轮如实返回", () => { const r = callTool("queue", {}, "mcp/t", deps); assert.equal(r.round, null); });
test("INSTRUCTIONS 六条协议在位", () => { assert.equal(INSTRUCTIONS.split("\n").length, 7); assert.ok(INSTRUCTIONS.includes("decision:")); });

test("defaultEnginePath handles exports that block package.json subpath", () => {
 const p=defaultEnginePath();assert.ok(p.endsWith("dist\\bundle\\bin.cjs"));assert.ok(existsSync(p));
});
test("taste_update 自助建提案、修订追加且不生效", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home=mkdtempSync(join(tmpdir(),"taste-proposals-"));
  const proposalsPath=join(home,"proposals.jsonl");
  const d={...deps,proposalsPath};
  const args={action:"propose",domain:"测试域",rule_id:"TEST-RULE-1",case:"test-case-r1",clause:"按源值展示",candidates:["A","B"],selected:"A",reason:"证据支持 A",anchor:"SOP §1",model:"test-model"};
  const callArgs={...args,session_id:"session-author"};
  const p1=callTool("update",callArgs,"dsh-session:session-author",d);
  assert.equal(p1.revision,1); assert.equal(p1.effective,false);
  const pdup=callTool("update",callArgs,"dsh-session:session-author",d); assert.equal(pdup.revision,1); assert.equal(pdup.duplicate,true);
  const p2=callTool("update",{...callArgs,proposal_id:p1.proposal_id,clause:"修订：源值为主值"},"dsh-session:session-author",d);
  assert.equal(p2.revision,2); assert.equal(p2.effective,false);
  assert.throws(()=>callTool("update",{action:"endorse",proposal_id:p1.proposal_id,revision:1,case:p1.case,verdict:"A",anchor:"a",reason:"stale",model:"test-model",session_id:"reviewer"},"dsh-session:reviewer",d),/提案版本已变化/);
  const read=callTool("rules",{},"agent-a",d);
  assert.equal(read.rules.length,1); assert.equal(read.proposals.length,1); assert.equal(read.proposals[0].revision,2);
  assert.equal(readFileSync(proposalsPath,"utf8").trim().split(/\r?\n/).length,2);
  rmSync(home,{recursive:true,force:true});
});
test("只有两个作者外、不同 session、非 decision 的同向判断才 active", () => {
 const p={proposal_id:"p",revision:1,rule_id:"R",domain:"d",case:"c",clause:"c",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",author:"agent:author@m",author_session:"session-author",author_model:"m",model:"m",proposed_at:"now",status:"pending_review",effective:false,independent:{},version:"v"};
 const vote=(session,verdict="A",ctx)=>({proposal_id:"p",revision:1,case:"c",verdict,judge:"agent:"+session,session,claim_id:session,at:"now",...(ctx?{ctx}:{})});
 assert.equal(proposalStatus(p,[vote("session-author"),vote("one","A","decision:seen"),vote("two")]).status,"pending_review");
 assert.equal(proposalStatus(p,[vote("one"),vote("one")]).status,"pending_review");
 assert.equal(proposalStatus(p,[vote("one"),vote("two")]).status,"active");
 assert.equal(proposalStatus(p,[vote("one"),vote("two","B")]).status,"pending_review");
 assert.equal(proposalStatus(p,[vote("one","B"),vote("one","C")]).status,"pending_review");
 assert.equal(proposalStatus(p,[vote("one","B"),vote("two","C")]).status,"needs_arbitration");
 assert.equal(proposalStatus(p,[vote("one"),vote("two","B"),vote("three","B")]).status,"needs_arbitration");
 const gateway={...p,author_session:undefined};
 assert.equal(proposalStatus(gateway,[vote("one"),vote("two")]).status,"pending_review");
 assert.equal(proposalStatus(gateway,[vote("one"),vote("two"),vote("three")]).status,"pending_review");
});

test("两个不同 DSH session 共识后规则 effective 但非 human ratified", async () => {
 const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const home=mkdtempSync(join(tmpdir(),"taste-consensus-"));const proposalsPath=join(home,"proposals.jsonl"),endorsementsPath=join(home,"endorsements.jsonl");
 const d={...deps,rulesPath:join(home,"rules.json"),proposalsPath,endorsementsPath};writeFileSync(d.rulesPath,"[]");
 const p=callTool("update",{action:"propose",domain:"新域",rule_id:"NEW-RULE-1",case:"new-case-1",clause:"条款 A",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",model:"test-model",session_id:"author-session"},"dsh-session:author-session",d);
 const vote=(session,verdict="A",ctx)=>({proposal_id:p.proposal_id,revision:1,case:"new-case-1",verdict,judge:"agent:"+session,session,claim_id:session,at:"now",...(ctx?{ctx}:{})});
 writeFileSync(endorsementsPath,[vote("one"),vote("two")].map(JSON.stringify).join("\n")+"\n");
 const active=callTool("rules",{domain:"新域"},"agent-x",d);assert.equal(active.rules.length,1);assert.equal(active.rules[0].effective,true);assert.equal(active.rules[0].ratified,false);assert.equal(active.rules[0].clause,"条款 A");
 writeFileSync(endorsementsPath,[vote("one"),vote("two","B"),vote("three","B")].map(JSON.stringify).join("\n")+"\n");
 const disputed=callTool("rules",{domain:"新域"},"agent-x",d);assert.equal(disputed.rules.length,0);assert.equal(disputed.proposals[0].status,"needs_arbitration");
 rmSync(home,{recursive:true,force:true});
});

test("新修订不得隐藏旧版本仲裁状态", async () => {
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const h=mkdtempSync(join(tmpdir(),"taste-p0-masking-")),pp=join(h,"p.jsonl"),ep=join(h,"e.jsonl");
 const make=(revision,selected="A",reason="r")=>({proposal_id:"p",revision,rule_id:"TEST-RULE-1",domain:"d",case:"c",clause:"c",candidates:["A","B"],selected,reason,anchor:"a",author:"author",author_session:"author-session",author_model:"m",model:"m",proposed_at:"now",status:"pending_review",effective:false,independent:{},version:"v"});
 writeFileSync(pp,[make(1),make(2,"A","changed")].map(JSON.stringify).join("\n")+"\n");
 const vote1={proposal_id:"p",revision:1,case:"c",verdict:"B",judge:"reviewer1",session:"reviewer1",claim_id:"vote1",at:"now"};
 const vote2={...vote1,judge:"reviewer2",session:"reviewer2",claim_id:"vote2"};writeFileSync(ep,[vote1,vote2].map(JSON.stringify).join("\n")+"\n");
 const view=callTool("update",{action:"list"},"reader",{...deps,proposalsPath:pp,endorsementsPath:ep});assert.equal(view.latest[0].status,"needs_arbitration");
 assert.equal(view.active.length,0);
 assert.throws(()=>callTool("update",{action:"propose",proposal_id:"p",domain:"d",rule_id:"TEST-RULE-1",case:"c",clause:"third revision",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",model:"m",session_id:"author-session"},"dsh-session:author-session",{...deps,proposalsPath:pp,endorsementsPath:ep}),/未解决的独立分歧/);
 rmSync(h,{recursive:true,force:true});
});


test("new pending revision preserves prior active version", async () => {
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const h=mkdtempSync(join(tmpdir(),"taste-incumbent-")),pp=join(h,"p.jsonl"),ep=join(h,"e.jsonl"),rp=join(h,"r.json");writeFileSync(rp,"[]");
 const base={proposal_id:"p",rule_id:"R",domain:"d",case:"c",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",author:"a",author_session:"sa",author_model:"m",model:"m",status:"pending_review",effective:false,independent:{},version:"v"};
 const one={...base,revision:1,clause:"old",proposed_at:"t1"},two={...base,revision:2,clause:"new",proposed_at:"t2"};writeFileSync(pp,[one,two].map(JSON.stringify).join("\n")+"\n");
 const v=(revision,session,verdict="A")=>({proposal_id:"p",revision,case:"c",verdict,judge:session,session,claim_id:session,at:"now"});writeFileSync(ep,[v(1,"s1"),v(1,"s2"),v(2,"s3")].map(JSON.stringify).join("\n")+"\n");
 const out=callTool("rules",{domain:"d"},"reader",{...deps,rulesPath:rp,proposalsPath:pp,endorsementsPath:ep});assert.equal(out.rules[0].effective,true);assert.equal(out.rules[0].clause,"old");assert.equal(out.proposals[0].status,"pending_review");rmSync(h,{recursive:true,force:true});
});
test("pending revision cannot hijack existing rule record vocabulary", async () => {
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const h=mkdtempSync(join(tmpdir(),"taste-p0-vocab-")),rp=join(h,"rules.json"),pp=join(h,"p.jsonl");
 writeFileSync(rp,JSON.stringify([{rule_id:"R1",domain:"d",clause:"existing",candidates:["A","B"],selected:"A"}]));
 const proposal={proposal_id:"p",revision:1,rule_id:"R1",domain:"d",case:"c",clause:"pending",candidates:["加号","分号"],selected:"加号",reason:"r",anchor:"a",author:"author",author_session:"s",author_model:"m",model:"m",proposed_at:"now",status:"pending_review",effective:false,independent:{},version:"v"};writeFileSync(pp,JSON.stringify(proposal)+"\n");
 assert.throws(()=>callTool("record",{domain:"d",case:"c",rule:"R1",verdict:"分号",anchor:"a",reason:"r",model:"m"},"agent",{...deps,rulesPath:rp,proposalsPath:pp}),/候选集/);
 rmSync(h,{recursive:true,force:true});
});


test("active proposal candidates override registered legacy candidates", async () => {
 const {mkdtempSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const h=mkdtempSync(join(tmpdir(),"taste-p2-vocab-")),rp=join(h,"rules.json"),pp=join(h,"p.jsonl");
 writeFileSync(rp,JSON.stringify([{rule_id:"R2",domain:"d",clause:"old",candidates:["A","B"],selected:"A"}]));
 const p={proposal_id:"p2",revision:1,rule_id:"R2",domain:"d",case:"c2",clause:"new",candidates:["加号","分号"],selected:"加号",reason:"r",anchor:"a",author:"author",author_session:"s0",author_model:"m",model:"m",proposed_at:"now",status:"pending_review",effective:false,independent:{},version:"v"};writeFileSync(pp,JSON.stringify(p)+"\n");
 const ep=join(h,"e.jsonl"),v=(session)=>({proposal_id:"p2",revision:1,case:"c2",verdict:"加号",judge:session,session,claim_id:session,at:"now"});writeFileSync(ep,[v("s1"),v("s2")].map(JSON.stringify).join("\n")+"\n");
 const d={...deps,rulesPath:rp,proposalsPath:pp,endorsementsPath:ep,inboxHome:join(h,"inbox"),enginePath:"D:/workspace/ygl-taste-pilot-verifier/node_modules/ygl-trees/dist/bundle/bin.cjs"};
 const ok=callTool("record",{domain:"d",case:"c2",rule:"R2",verdict:"加号",anchor:"a",reason:"accepted version",model:"m"},"agent",d);assert.ok(ok.claim_id);
 assert.throws(()=>callTool("record",{domain:"d",case:"c2",rule:"R2",verdict:"A",anchor:"a",reason:"old version",model:"m"},"agent",d),/有效规则候选集/);
 rmSync(h,{recursive:true,force:true});
});
test("独立反向来源使自助规则进入仲裁而不生效", async () => {
 const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const home=mkdtempSync(join(tmpdir(),"taste-dispute-"));const proposalsPath=join(home,"proposals.jsonl"),endorsementsPath=join(home,"endorsements.jsonl"),rulesPath=join(home,"rules.json");writeFileSync(rulesPath,"[]");
 const p={proposal_id:"p",revision:1,rule_id:"R",domain:"d",case:"c",clause:"a",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",author:"author",author_session:"s0",author_model:"m",model:"m",proposed_at:"now",status:"pending_review",effective:false,independent:{},version:"v"};writeFileSync(proposalsPath,JSON.stringify(p)+"\n");
 const v=(session,verdict)=>({proposal_id:"p",revision:1,case:"c",verdict,judge:session,session,claim_id:session,at:"now"});writeFileSync(endorsementsPath,[v("s1","A"),v("s2","B"),v("s3","B")].map(JSON.stringify).join("\n")+"\n");
 const out=callTool("rules",{domain:"d"},"agent",{...deps,rulesPath,proposalsPath,endorsementsPath});assert.equal(out.rules.length,0);assert.equal(out.proposals[0].status,"needs_arbitration");assert.equal(out.proposals[0].effective,false);rmSync(home,{recursive:true,force:true});
});

test("gateway may submit proposals but cannot supply endorsement identity", async () => {
  const {mkdtempSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const home=mkdtempSync(join(tmpdir(),"taste-gateway-")),d={...deps,proposalsPath:join(home,"p.jsonl")};
  const p=callTool("update",{action:"propose",domain:"d",rule_id:"TEST-RULE-1",case:"c",clause:"c",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",model:"test-model"},"mcp/market-gateway",d);assert.equal(p.status,"pending_review");
  assert.throws(()=>callTool("update",{action:"endorse",proposal_id:p.proposal_id,revision:1,case:"c",verdict:"A",reason:"r",anchor:"a",model:"test-model"},"mcp/market-gateway",d),/session ID/);
  assert.equal(proposalStatus({...p,author_session:undefined},[{proposal_id:p.proposal_id,revision:1,case:"c",verdict:"A",judge:"one",session:"one",claim_id:"1",at:"now"},{proposal_id:p.proposal_id,revision:1,case:"c",verdict:"A",judge:"two",session:"two",claim_id:"2",at:"now"},{proposal_id:p.proposal_id,revision:1,case:"c",verdict:"A",judge:"three",session:"three",claim_id:"3",at:"now"}]).effective,false);
  rmSync(home,{recursive:true,force:true});
});

test("blind view omits proposer verdict and rationale", async () => {
 const {mkdtempSync,readFileSync,writeFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");const h=mkdtempSync(join(tmpdir(),"taste-blind-")),d={...deps,proposalsPath:join(h,"p.jsonl")};
 const p=callTool("update",{action:"propose",domain:"d",rule_id:"BLIND-RULE-1",case:"blind-case",clause:"clause",candidates:["A","B"],selected:"A",reason:"secret rationale",anchor:"anchor",model:"test-model",session_id:"author"},"dsh-session:author",d);
 const resolutionsPath=join(h,"resolutions.jsonl");writeFileSync(resolutionsPath,JSON.stringify({proposal_id:p.proposal_id,revision:1,verdict:"B",disposition:"accept",session:"arbiter",reason:"resolved",claim_id:"arbiter-claim",at:"now"})+"\n");
 const view=callTool("update",{action:"blind",proposal_id:p.proposal_id},"dsh-session:reviewer",{...d, resolutionsPath});assert.equal(view.latest[0].selected,"[blind]");assert.equal(view.latest[0].reason,"[blind]");assert.equal(view.latest[0].author_session,undefined);assert.equal(view.latest[0].status,"pending_review");assert.equal(view.latest[0].effective,false);assert.deepEqual(view.latest[0].independent,{});rmSync(h,{recursive:true,force:true});
});

test("resolver must be allowlisted and append an arbitration claim", async () => {
 const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
 const home=mkdtempSync(join(tmpdir(),"taste-resolver-")),pp=join(home,"p.jsonl"),rp=join(home,"resolutions.jsonl"),rulesPath=join(home,"rules.json"),claimsHome=join(home,"inbox");writeFileSync(rulesPath,"[]");
 const p={proposal_id:"resolve-me",revision:1,rule_id:"RESOLVE-RULE-1",domain:"d",case:"case-resolve",clause:"c",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",author:"agent:a",author_session:"author-session",author_model:"m",model:"m",proposed_at:"now",status:"needs_arbitration",effective:false,independent:{},version:"v"};writeFileSync(pp,JSON.stringify(p)+"\n");
 const d={...deps,rulesPath,proposalsPath:pp,resolutionsPath:rp,arbiterSessionIds:["arbiter-session"],inboxHome:claimsHome,enginePath:join("D:/workspace/ygl-taste-pilot-verifier/node_modules/ygl-trees/dist/bundle/bin.cjs")};
 assert.throws(()=>callTool("update",{action:"resolve",proposal_id:"resolve-me",revision:1,verdict:"B",disposition:"accept",reason:"r"},"dsh-session:other",d),/arbiter session/);
 const out=callTool("update",{action:"resolve",proposal_id:"resolve-me",revision:1,verdict:"B",disposition:"accept",reason:"independent human review"},"dsh-session:arbiter-session",d);assert.equal(out.active,true);assert.ok(out.claim_id);
 const view=callTool("rules",{domain:"d"},"reader",d);assert.equal(view.rules[0].selected,"B");
 const rows=readFileSync(rp,"utf8").trim().split(/\r?\n/);assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0]).disposition,"accept");rmSync(home,{recursive:true,force:true});
});
test("taste_update 拒绝跨域接管已有 rule_id", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home=mkdtempSync(join(tmpdir(),"taste-proposals-domain-"));
  const rulesPath=join(home,"rules.json");
  writeFileSync(rulesPath,JSON.stringify([{rule_id:"TEST-RULE-1",domain:"原域",clause:"原条款"} ]));
  const d={...deps,rulesPath,proposalsPath:join(home,"proposals.jsonl")};
  assert.throws(()=>callTool("update",{action:"propose",domain:"另一个域",rule_id:"TEST-RULE-1",case:"case-r1",clause:"改写",candidates:["A","B"],selected:"A",reason:"r",anchor:"a",model:"test-model",session_id:"session-a"},"dsh-session:session-a",d),/其他域/);
  rmSync(home,{recursive:true,force:true});
});
