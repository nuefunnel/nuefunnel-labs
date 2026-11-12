// What the ChatGPT app starts (.mcp.json). It checks Node before loading the server: with Node older
// than 22.13 the server would die on start-up without saying why, because node:sqlite is missing.
// Instead this writes the reason to events.log and answers the app with it, so ChatGPT can tell you.
// Keep this file to syntax that old Node versions can parse: no top-level await, no ?. or ??.
import fs from "node:fs";
import os from "node:os";
import readline from "node:readline";

var NEED = [22, 13];
var have = process.versions.node.split(".").map(Number);
var ok = have[0] > NEED[0] || (have[0] === NEED[0] && have[1] >= NEED[1]);

var DATA = process.env.READBACK_DATA || os.homedir() + "/Library/Application Support/Readback";
function log(msg) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.appendFileSync(DATA + "/events.log", new Date().toISOString() + " [" + process.pid + "] " + msg + "\n");
  } catch (e) {}
}

if (ok) {
  import("./dist/server.mjs").catch(function (e) {
    log("start-up failed " + JSON.stringify(String((e && e.stack) || e)));
    process.stderr.write("Readback failed to start: " + ((e && e.message) || e) + "\n");
    process.exit(1);
  });
} else {
  var problem = "Readback needs Node.js " + NEED.join(".") + " or newer, but the ChatGPT app started it with Node " +
    process.versions.node + " (" + process.execPath + "). Install the current LTS release from https://nodejs.org " +
    "or with `brew install node`, then quit and reopen ChatGPT.";
  log("node too old " + JSON.stringify({ node: process.versions.node, path: process.execPath }));
  process.stderr.write(problem + "\n");

  // A minimal MCP server over stdio that only reports the problem.
  var version = "unknown";
  try { version = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version; } catch (e) {}
  var send = function (id, result, error) {
    var msg = { jsonrpc: "2.0", id: id };
    if (error) msg.error = error; else msg.result = result;
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
  readline.createInterface({ input: process.stdin }).on("line", function (line) {
    var req;
    try { req = JSON.parse(line); } catch (e) { return; }
    if (!req || req.id === undefined || req.id === null) return; // a notification
    if (req.method === "initialize") {
      send(req.id, {
        protocolVersion: (req.params && req.params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "readback", title: "Readback", version: version },
        instructions: problem,
      });
    } else if (req.method === "tools/list") {
      send(req.id, { tools: [{
        name: "readback_setup_problem",
        title: "Readback can't start",
        description: "Explains why Readback can't start on this Mac. Call it whenever the user asks for Readback or their feeds. " + problem,
        inputSchema: { type: "object", properties: {} },
      }] });
    } else if (req.method === "tools/call") {
      send(req.id, { content: [{ type: "text", text: problem }], isError: true });
    } else if (req.method === "ping") {
      send(req.id, {});
    } else if (/\/list$/.test(req.method || "")) {
      send(req.id, req.method === "resources/list" ? { resources: [] }
        : req.method === "resources/templates/list" ? { resourceTemplates: [] }
        : req.method === "prompts/list" ? { prompts: [] } : {});
    } else {
      send(req.id, null, { code: -32601, message: problem });
    }
  });
}
