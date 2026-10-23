#!/usr/bin/env node
/**
 * 双实现同源 drift 检查（评审裁定 Q2）：插件 src/mcp-core.ts 与验证器仓 services/taste-mcp/server.mjs
 * 的共享段（INSTRUCTIONS 协议文本 + 语法校验正则）规范化后比对——漂移即非零退出。
 * 用法：node scripts/check-drift.mjs [verifierRepo]（默认 ../ygl-taste-pilot-verifier）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const repo = resolve(process.argv[2] ?? new URL("../../ygl-taste-pilot-verifier/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const a = readFileSync(resolve(process.cwd(), "src/mcp-core.ts"), "utf8");
const b = readFileSync(resolve(repo, "services/taste-mcp/server.mjs"), "utf8");
const grab = (s, re) => { const m = re.exec(s); return m ? m[1] : null; };
const norm = (s) => s.replace(/\s+/g, "").replace(/['"`]/g, "");
let bad = 0;
const instrA = norm(grab(a, /INSTRUCTIONS\s*=\s*\[([\s\S]*?)\]\.join/) ?? "");
const instrB = norm(grab(b, /INSTRUCTIONS\s*=\s*\[([\s\S]*?)\]\.join/) ?? "");
if (!instrA || !instrB) { console.error("drift: 无法提取 INSTRUCTIONS（语法变化？）"); bad = 1; }
else if (instrA !== instrB) { console.error("drift: INSTRUCTIONS 协议文本漂移"); bad = 1; }
for (const [name, re] of [["CLIENT_RE", /CLIENT_RE\s*=\s*(\/[^\n]+)/], ["MODEL_RE", /MODEL_RE\s*=\s*(\/[^\n]+)/], ["FORBIDDEN", /FORBIDDEN\s*=\s*(\/[^\n]+)/]]) {
  const ra = grab(a, re), rb = grab(b, re);
  if (!ra || !rb || norm(ra) !== norm(rb)) { console.error(`drift: ${name} 不一致或无法提取`); bad = 1; }
}
if (bad) { console.error(`对照源：${repo}`); process.exit(1); }
console.log("drift ok: INSTRUCTIONS 与三正则与验证器仓 server.mjs 同源一致");
