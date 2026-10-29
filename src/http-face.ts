/**
 * taste-mcp StreamableHTTP 面（move-not-rewrite 自验证器仓 server.mjs 的 handler）。
 * 只认 X-Market-Client 网关身份头；POST-only；无状态 JSON-RPC 2.0。
 * 供市场网关 upstream（taste__*）与门户代理消费；与插件原生工具共用同一核心。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { callTool, CLIENT_RE, INSTRUCTIONS, type CoreDeps, type ToolName } from "./mcp-core.js";

const PROTOCOL = "2025-03-26";
const KNOWN_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18"];

export function handler(deps: CoreDeps) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    if (req.url !== "/mcp" && req.url !== "/mcp/") return send(404, { error: "not found" });
    if (req.method !== "POST") return send(405, { error: "stateless StreamableHTTP：仅支持 POST" });
    const client = String(req.headers["x-market-client"] ?? "");
    if (!CLIENT_RE.test(client)) return send(401, { error: "缺少或无效的 X-Market-Client：本服务只接受工作台市场 MCP 网关转发的请求" });
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => { raw += c; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on("end", () => {
      let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(raw || "{}"); } catch { return send(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
      const fail = (code: number, message: string): void => send(200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
      if (typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request");
      if (msg.id === undefined || msg.id === null) { res.writeHead(202); return res.end(); }
      try {
        if (msg.method === "initialize") {
          const want = typeof msg.params?.protocolVersion === "string" ? String(msg.params.protocolVersion) : "";
          return send(200, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: KNOWN_PROTOCOLS.includes(want) ? want : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "taste-mcp", version: "0.1.0", title: "品味闭环" }, instructions: INSTRUCTIONS } });
        }
        if (msg.method === "ping") return send(200, { jsonrpc: "2.0", id: msg.id, result: {} });
        if (msg.method === "tools/list") {
          return send(200, { jsonrpc: "2.0", id: msg.id, result: { tools: [
            { name: "rules", description: "动手前先调：返回本域规则与提案。ratified=true 是人工认定；effective=true 是两名作者外独立 DSH session 同向形成的域内当前版本；pending 仅供记录判断。", inputSchema: { type: "object", properties: { domain: { type: "string" } }, additionalProperties: false } },
            { name: "case", description: "生成确定性案例 id：同一对象同一位置永远同 id，不同 agent 对同一判断点必须用同一 id 才能比对。", inputSchema: { type: "object", properties: { object: { type: "string" }, position: { type: "string" } }, required: ["object", "position"], additionalProperties: false } },
            { name: "record", description: "在『哪种做法对』的判断点记一条品味判断后继续工作；身份由通道确认，model 填你的模型 id；看过既有裁决 ctx 必须以 decision: 开头。", inputSchema: { type: "object", properties: { domain: { type: "string" }, case: { type: "string" }, rule: { type: "string" }, verdict: { type: "string" }, anchor: { type: "string" }, reason: { type: "string" }, model: { type: "string" }, ctx: { type: "string" }, layer: { type: "string", enum: ["L0", "L1", "L2", "L3", "L4"] } }, required: ["domain", "case", "rule", "verdict", "anchor", "reason", "model"], additionalProperties: false } },
            { name: "queue", description: "查看待仲裁分歧、到期结算和规则认定状态。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "update", description: "自助创建/修订规则提案并对指定版本盲判；每条提案使用固定 case ID，只有同一版本同向共识才 active。", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["propose", "list", "blind", "endorse", "resolve"] }, domain: { type: "string" }, rule_id: { type: "string" }, proposal_id: { type: "string" }, revision: { type: "number" }, case: { type: "string" }, clause: { type: "string" }, candidates: { type: "array", items: { type: "string" } }, selected: { type: "string" }, verdict: { type: "string" }, disposition: { type: "string", enum: ["accept", "reject"] }, reason: { type: "string" }, anchor: { type: "string" }, model: { type: "string" }, ctx: { type: "string" } }, additionalProperties: false } },
          ] } });
        }
        if (msg.method === "tools/call") {
          if (typeof msg.params?.name !== "string") return fail(-32602, "params.name 必填");
          try {
            const out = callTool(msg.params.name as ToolName, (msg.params.arguments as Record<string, unknown>) ?? {}, "mcp/" + client, deps);
            return send(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] } });
          } catch (e) {
            return send(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `执行失败：${(e as Error)?.message || e}` }], isError: true } });
          }
        }
        return fail(-32601, `Method not found: ${msg.method}`);
      } catch (e) {
        return fail(-32603, `Internal error: ${(e as Error)?.message || e}`);
      }
    });
  };
}

export async function startTasteHttp(host: string, port: number, deps: CoreDeps): Promise<{ server: Server; url: string; dispose: () => Promise<void> }> {
  const server = createServer(handler(deps));
  await new Promise<void>((r) => server.listen(port, host, r));
  const addr = server.address();
  const url = `http://${host}:${typeof addr === "object" && addr ? addr.port : port}/mcp`;
  return { server, url, dispose: () => new Promise((r) => server.close(() => r())) };
}
