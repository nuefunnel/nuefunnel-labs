// Minimal MCP Apps bridge (JSON-RPC 2.0 over postMessage), protocol 2026-01-26.
// Implements only what the reader needs: initialize, tools/call, ui/message,
// ui/update-model-context, ui/open-link, and the tool-result / host-context notifications.
export type Bridge = {
  ready: Promise<any>;
  call(name: string, args?: any): Promise<any>;
  message(text: string, opts?: { quote?: string; send?: boolean; target?: "active" | "new" }): Promise<any>;
  context(blocks: any[], structured?: any): Promise<any>;
  openLink(url: string): Promise<any>;
  onToolResult(cb: (r: any) => void): void;
  onHostContext(cb: (c: any) => void): void;
};
export function createBridge(): Bridge {
  let id = 0; const pending = new Map<number, [Function, Function]>();
  let onResult: (r: any) => void = () => {}; let onCtx: (c: any) => void = () => {};
  let early: any = null;
  const post = (m: any) => window.parent.postMessage({ jsonrpc: "2.0", ...m }, "*");
  const req = (method: string, params: any) => new Promise<any>((res, rej) => { const i = ++id; pending.set(i, [res, rej]); post({ id: i, method, params }); });
  window.addEventListener("message", e => {
    if (e.source !== window.parent) return; const m = e.data; if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && pending.has(m.id) && !m.method) { const [res, rej] = pending.get(m.id)!; pending.delete(m.id); m.error ? rej(m.error) : res(m.result); return; }
    if (m.method === "ui/notifications/tool-result") { early = m.params; onResult(m.params); }
    else if (m.method === "ui/notifications/host-context-changed") onCtx(m.params);
    else if (m.method === "ui/resource-teardown" && m.id != null) post({ id: m.id, result: {} });
    else if (m.method === "ping" && m.id != null) post({ id: m.id, result: {} });
  });
  const ready = req("ui/initialize", { appInfo: { name: "readback", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(r => { post({ method: "ui/notifications/initialized", params: {} }); onCtx(r.hostContext || {}); return r; });
  return {
    ready,
    call: (name, args = {}) => req("tools/call", { name, arguments: args }).then(r => { if (r?.isError) throw new Error(r.content?.[0]?.text || "tool error"); return r.structuredContent ?? JSON.parse(r.content?.[0]?.text || "{}"); }),
    message: (text, o = {}) => req("ui/message", { role: "user", content: [...(o.quote ? [{ type: "text", text: o.quote, _meta: { "openai/title": "Selection" } }] : []), ...(text ? [{ type: "text", text }] : [])], _meta: { "openai/message": { target: o.target || "active", send: o.send ?? true } } }),
    context: (content, structuredContent) => req("ui/update-model-context", { content, ...(structuredContent ? { structuredContent } : {}) }),
    openLink: url => req("ui/open-link", { url }),
    onToolResult: cb => { onResult = cb; if (early) cb(early); },
    onHostContext: cb => { onCtx = cb; },
  };
}
