// Preview the reader outside ChatGPT: a tiny host that speaks the same postMessage protocol and forwards
// tool calls to the built server over stdio. Uses a copy of your Readback data so nothing real changes.
// Usage: node scripts/dev-host.mjs [port]   then open http://localhost:<port>/?theme=dark&w=1000
import http from "node:http"; import fs from "node:fs"; import os from "node:os"; import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = new URL("..", import.meta.url).pathname, port = +(process.argv[2] || 8799);
const real = `${os.homedir()}/Library/Application Support/Readback`, data = fs.mkdtempSync(os.tmpdir() + "/readback-preview-");
if (fs.existsSync(real + "/readback.sqlite")) execFileSync("sqlite3", [real + "/readback.sqlite", `.backup '${data}/readback.sqlite'`]);
const c = new Client({ name: "dev-host", version: "0" });
await c.connect(new StdioClientTransport({ command: "node", args: ["--no-warnings", root + "launch.mjs"], env: { ...process.env, READBACK_DATA: data } }));
const page = `<!doctype html><meta charset="utf-8"><title>Readback preview</title>
<style>body{margin:0;font:12px system-ui;background:#e9ebef;display:flex;height:100vh}iframe{border:0;background:#fff;height:100%}#log{flex:1;overflow:auto;padding:8px;white-space:pre-wrap;color:#333;min-width:200px}</style>
<iframe id="f" sandbox="allow-scripts allow-same-origin allow-forms"></iframe><div id="log"></div>
<script>
const q=new URLSearchParams(location.search), f=document.getElementById('f'); f.style.width=(q.get('w')||1100)+'px';
const log=(...a)=>{document.getElementById('log').textContent+=a.map(x=>typeof x==='string'?x:JSON.stringify(x).slice(0,300)).join(' ')+'\\n'};
const call=(name,args)=>fetch('/call',{method:'POST',body:JSON.stringify({name,arguments:args||{}})}).then(r=>r.json());
const post=m=>f.contentWindow.postMessage({jsonrpc:'2.0',...m},'*');
addEventListener('message',async e=>{const m=e.data; if(e.source!==f.contentWindow||!m||m.jsonrpc!=='2.0')return;
  if(m.method==='ui/initialize'){post({id:m.id,result:{protocolVersion:'2026-01-26',hostContext:{theme:q.get('theme')||'light'},hostCapabilities:{}}});}
  else if(m.method==='ui/notifications/initialized'){post({method:'ui/notifications/tool-result',params:await call('open_reader')});}
  else if(m.method==='tools/call'){const r=await call(m.params.name,m.params.arguments);post({id:m.id,result:r});}
  else if(m.method==='ui/message'||m.method==='ui/update-model-context'||m.method==='ui/open-link'){log(m.method,m.params);post({id:m.id,result:{}});}
  else if(m.id!=null)post({id:m.id,result:{}});
});
fetch('/ui').then(r=>r.text()).then(h=>{f.srcdoc=h.replace('<head>','<head><meta http-equiv="Content-Security-Policy" content="default-src \\'none\\'; script-src \\'unsafe-inline\\'; style-src \\'unsafe-inline\\'; img-src data:; connect-src \\'none\\'">');});
</script>`;
http.createServer(async (req, res) => {
  if (req.url.startsWith("/call")) { let b = ""; for await (const ch of req) b += ch; const { name, arguments: a } = JSON.parse(b);
    const r = await c.callTool({ name, arguments: a }); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(r)); return; }
  if (req.url === "/ui") { res.end(fs.readFileSync(root + "dist/ui.html")); return; }
  res.setHeader("content-type", "text/html"); res.end(page);
}).listen(port, () => console.log(`preview at http://localhost:${port}/  (data copy: ${data})`));
