// Fake upstream for the smoke test: echoes back which PAT and headers arrived,
// as a slow SSE stream so we can prove the proxy forwards chunks without buffering.
import { createServer } from "node:http";

createServer(async (rq, res) => {
  const chunks = [];
  for await (const c of rq) chunks.push(c);
  const seen = {
    method: rq.method,
    url: rq.url,
    auth: rq.headers.authorization,
    accept: rq.headers.accept,
    contentType: rq.headers["content-type"],
    session: rq.headers["mcp-session-id"],
    protocol: rq.headers["mcp-protocol-version"],
    body: Buffer.concat(chunks).toString(),
  };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Mcp-Session-Id": "upstream-session-42",
    "MCP-Protocol-Version": "2025-06-18",
  });
  res.write(`data: ${JSON.stringify(seen)}\n\n`);
  setTimeout(() => {
    res.write(`data: ${JSON.stringify({ second: true })}\n\n`);
    res.end();
  }, 700);
}).listen(8899);
