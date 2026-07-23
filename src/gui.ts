/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import { decodeJournalToCapture, summarizeJournal } from "./journal.js";
import { encodeJavaStructure, encodeJavaStructureGzip } from "./nbt.js";
import type { Vec3 } from "./types.js";
import { extractJavaStructure } from "./world.js";

export interface GuiOptions {
  readonly host?: string;
  readonly port?: number;
  readonly openBrowser?: boolean;
}

interface PipelineRequest {
  readonly journal: string;
  readonly from: Vec3;
  readonly to: Vec3;
  readonly strict?: boolean;
  readonly protocolVersion?: string;
  readonly dataVersion?: number;
  readonly includeAir?: boolean;
  readonly includeEntities?: boolean;
  readonly compressed?: boolean;
  readonly unsupported?: "barrier" | "air" | "throw";
}

const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CBE-R GUI</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101418;color:#eef2f5}body{margin:0}.wrap{max-width:980px;margin:auto;padding:28px}.card{background:#182028;border:1px solid #2d3944;border-radius:16px;padding:20px;margin:16px 0;box-shadow:0 12px 30px #0004}h1{margin:0 0 8px}.muted{color:#aab7c2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}label{display:grid;gap:6px;font-size:14px}input,select,button{font:inherit;border-radius:9px;border:1px solid #43515d;background:#10161c;color:#fff;padding:10px}button{cursor:pointer;background:#2f7cf6;border-color:#2f7cf6;font-weight:700}button.secondary{background:#27333d;border-color:#43515d}button:disabled{opacity:.55;cursor:not-allowed}pre{white-space:pre-wrap;max-height:280px;overflow:auto;background:#0b0f13;padding:14px;border-radius:10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ok{color:#74d99f}.err{color:#ff8c8c}
</style></head><body><div class="wrap"><h1>CBE-R</h1><div class="muted">Bedrock packet journal → Java Structure NBT</div>
<div class="card"><h2>1. ジャーナル</h2><input id="file" type="file" accept=".ndjson,.json,.txt"><div class="row" style="margin-top:12px"><button id="analyze" class="secondary">解析</button><span id="fileInfo" class="muted">未選択</span></div><pre id="analysis">ファイルを選択してください。</pre></div>
<div class="card"><h2>2. 出力範囲</h2><div class="grid"><label>From X<input id="fx" type="number" value="0"></label><label>From Y<input id="fy" type="number" value="0"></label><label>From Z<input id="fz" type="number" value="0"></label><label>To X<input id="tx" type="number" value="31"></label><label>To Y<input id="ty" type="number" value="31"></label><label>To Z<input id="tz" type="number" value="31"></label></div></div>
<div class="card"><h2>3. 変換設定</h2><div class="grid"><label>Java DataVersion<input id="dv" type="number" value="3955"></label><label>未対応ブロック<select id="unsupported"><option value="barrier">Barrier</option><option value="air">Air</option><option value="throw">Error</option></select></label><label>プロトコル版（任意）<input id="version" placeholder="auto"></label></div><div class="row" style="margin-top:14px"><label><input id="strict" type="checkbox"> 厳格モード</label><label><input id="air" type="checkbox"> 空気を含める</label><label><input id="entities" type="checkbox"> エンティティを含める</label><label><input id="gzip" type="checkbox" checked> gzip圧縮</label></div><div class="row" style="margin-top:16px"><button id="download">NBTを生成・保存</button><span id="status" class="muted"></span></div></div>
<script>
let journal='';const $=id=>document.getElementById(id);$('file').addEventListener('change',async e=>{const f=e.target.files[0];journal=f?await f.text():'';$('fileInfo').textContent=f?f.name+' / '+f.size.toLocaleString()+' bytes':'未選択';});
async function post(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'HTTP '+r.status);return r;}
$('analyze').onclick=async()=>{try{if(!journal)throw new Error('ファイルを選択してください');$('analysis').textContent='解析中…';const r=await post('/api/analyze',{journal});const s=await r.json();$('analysis').textContent=JSON.stringify(s,null,2);}catch(e){$('analysis').textContent=e.message;}};
$('download').onclick=async()=>{const b=$('download');try{if(!journal)throw new Error('ファイルを選択してください');b.disabled=true;$('status').className='muted';$('status').textContent='変換中…';const body={journal,from:[+$('fx').value,+$('fy').value,+$('fz').value],to:[+$('tx').value,+$('ty').value,+$('tz').value],strict:$('strict').checked,includeAir:$('air').checked,includeEntities:$('entities').checked,compressed:$('gzip').checked,dataVersion:+$('dv').value,unsupported:$('unsupported').value};if($('version').value.trim())body.protocolVersion=$('version').value.trim();const r=await post('/api/pipeline',body);const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='building.nbt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);$('status').className='ok';$('status').textContent='完了: '+blob.size.toLocaleString()+' bytes';}catch(e){$('status').className='err';$('status').textContent=e.message;}finally{b.disabled=false;}};
</script></div></body></html>`;

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 512 * 1024 * 1024) throw new Error("Request is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isInteger);
}

function openUrl(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

export async function startGui(options: GuiOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(HTML), "cache-control": "no-store" });
        res.end(HTML); return;
      }
      if (req.method === "POST" && req.url === "/api/analyze") {
        const body = await readJson(req) as { journal?: unknown };
        if (typeof body.journal !== "string") throw new TypeError("journal must be a string");
        json(res, 200, summarizeJournal(body.journal)); return;
      }
      if (req.method === "POST" && req.url === "/api/pipeline") {
        const body = await readJson(req) as Partial<PipelineRequest>;
        if (typeof body.journal !== "string" || !isVec3(body.from) || !isVec3(body.to)) throw new TypeError("journal, from, and to are required");
        const document = decodeJournalToCapture(body.journal, { strict: body.strict ?? false, ...(body.protocolVersion ? { protocolVersion: body.protocolVersion } : {}) });
        const structure = extractJavaStructure(document, body.from, body.to, {
          dataVersion: body.dataVersion ?? 3955,
          includeAir: body.includeAir ?? false,
          includeEntities: body.includeEntities ?? false,
          unsupportedBlockPolicy: body.unsupported ?? "barrier",
        });
        const encoded = body.compressed === false ? encodeJavaStructure(structure) : encodeJavaStructureGzip(structure);
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": "attachment; filename=building.nbt", "content-length": encoded.length, "cache-control": "no-store" });
        res.end(encoded); return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to determine GUI address");
  const url = `http://${host}:${address.port}/`;
  if (options.openBrowser !== false) openUrl(url);
  return { url, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
