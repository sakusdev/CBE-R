/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { decodeJournalToCapture, summarizeJournal } from "./journal.js";
import { startBedrockCapture, type CaptureSummary, type LiveCaptureSession } from "./live.js";
import { encodeJavaStructure, encodeJavaStructureGzip } from "./nbt.js";
import { captureBounds } from "./planning.js";
import type { CaptureDocument, Vec3 } from "./types.js";
import { extractJavaStructure } from "./world.js";

export interface GuiOptions {
  readonly host?: string;
  readonly port?: number;
  readonly openBrowser?: boolean;
}

interface PipelineRequest {
  readonly journal?: string;
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

interface CaptureStartRequest {
  readonly host?: string;
  readonly port?: number;
  readonly username?: string;
  readonly version?: string;
  readonly offline?: boolean;
  readonly profilesFolder?: string;
  readonly raknetBackend?: "jsp-raknet" | "raknet-node" | "raknet-native";
}

interface CoverageSummary {
  readonly covered: number;
  readonly missing: number;
  readonly minChunkX: number;
  readonly maxChunkX: number;
  readonly minChunkZ: number;
  readonly maxChunkZ: number;
  readonly chunks: readonly (readonly [x: number, z: number])[];
}

interface CaptureInspection {
  readonly summary: ReturnType<typeof summarizeJournal>;
  readonly bounds?: readonly [min: Vec3, max: Vec3];
  readonly coverage?: CoverageSummary;
  readonly blocks?: number;
  readonly entities?: number;
  readonly decodeError?: string;
}

interface CompletedCapture extends CaptureInspection {
  readonly capture: CaptureSummary;
}

interface ActiveCapture {
  readonly session: LiveCaptureSession;
  readonly path: string;
  completion: Promise<CompletedCapture>;
}

const HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CBE-R GUI</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101418;color:#eef2f5}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1080px;margin:auto;padding:28px}.card{background:#182028;border:1px solid #2d3944;border-radius:14px;padding:20px;margin:16px 0}h1{margin:0 0 6px}.muted{color:#aab7c2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}label{display:grid;gap:6px;font-size:14px}input,select,button{font:inherit;border-radius:8px;border:1px solid #43515d;background:#10161c;color:#fff;padding:10px}button{cursor:pointer;background:#2f7cf6;border-color:#2f7cf6;font-weight:700}button.secondary{background:#27333d;border-color:#43515d}button.stop{background:#943b46;border-color:#b44b58}button:disabled{opacity:.5;cursor:not-allowed}pre{white-space:pre-wrap;max-height:280px;overflow:auto;background:#0b0f13;padding:14px;border-radius:10px}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.ok{color:#74d99f}.err{color:#ff8c8c}.pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#263440;font-size:12px}canvas{width:100%;height:220px;background:#0b0f13;border-radius:10px;margin-top:12px;image-rendering:pixelated}
</style></head><body><div class="wrap"><h1>CBE-R</h1><div class="muted">Bedrock client traffic → Java Structure NBT</div>
<div class="card"><h2>1. ライブキャプチャ</h2><div class="grid"><label>Server host<input id="host" placeholder="example.org"></label><label>Port<input id="port" type="number" value="19132"></label><label>Xbox/Profile name<input id="username" placeholder="ProfileName"></label><label>Profiles folder<input id="profiles" value=".auth"></label><label>Bedrock version<input id="version" placeholder="auto"></label><label>RakNet<select id="raknet"><option value="jsp-raknet">jsp-raknet</option><option value="raknet-node">raknet-node</option><option value="raknet-native">raknet-native</option></select></label></div><div class="row" style="margin-top:14px"><label><input id="offline" type="checkbox"> Offline auth</label><button id="captureStart">接続・録画開始</button><button id="captureStop" class="stop" disabled>録画停止</button><span id="captureState" class="muted">停止中</span></div><canvas id="coverage" width="960" height="220"></canvas><div id="coverageInfo" class="muted">チャンクカバレッジは録画停止後に表示されます。</div></div>
<div class="card"><h2>2. 既存ジャーナル（任意）</h2><input id="file" type="file" accept=".ndjson,.json,.txt"><div class="row" style="margin-top:12px"><button id="analyze" class="secondary">解析</button><button id="useBounds" class="secondary">検出範囲を使用</button><span id="fileInfo" class="muted">ライブキャプチャ結果をそのまま使えます。</span></div><pre id="analysis">まだ解析していません。</pre></div>
<div class="card"><h2>3. 出力範囲</h2><div class="grid"><label>From X<input id="fx" type="number" value="0"></label><label>From Y<input id="fy" type="number" value="0"></label><label>From Z<input id="fz" type="number" value="0"></label><label>To X<input id="tx" type="number" value="31"></label><label>To Y<input id="ty" type="number" value="31"></label><label>To Z<input id="tz" type="number" value="31"></label></div></div>
<div class="card"><h2>4. NBT出力</h2><div class="grid"><label>Java DataVersion<input id="dv" type="number" value="3955"></label><label>未対応ブロック<select id="unsupported"><option value="barrier">Barrier</option><option value="air">Air</option><option value="throw">Error</option></select></label></div><div class="row" style="margin-top:14px"><label><input id="strict" type="checkbox"> 厳格モード</label><label><input id="air" type="checkbox"> 空気を含める</label><label><input id="entities" type="checkbox"> エンティティを含める</label><label><input id="gzip" type="checkbox" checked> gzip圧縮</label></div><div class="row" style="margin-top:16px"><button id="download">NBTを生成・保存</button><span id="status" class="muted"></span></div></div>
<script>
let journal='';let lastInspection=null;const $=id=>document.getElementById(id);
const saved=JSON.parse(localStorage.getItem('cber-settings')||'{}');for(const id of ['host','port','version','raknet'])if(saved[id]!=null)$(id).value=saved[id];$('offline').checked=!!saved.offline;
function saveSettings(){localStorage.setItem('cber-settings',JSON.stringify({host:$('host').value,port:$('port').value,version:$('version').value,raknet:$('raknet').value,offline:$('offline').checked}));}
async function post(path,body={}){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||'HTTP '+r.status);return r;}
function applyBounds(bounds){if(!bounds)return;const [a,b]=bounds;[$('fx').value,$('fy').value,$('fz').value]=a.map(String);[$('tx').value,$('ty').value,$('tz').value]=b.map(String);}
function drawCoverage(c){const canvas=$('coverage'),ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);if(!c||!c.chunks.length)return;const sx=c.maxChunkX-c.minChunkX+1,sz=c.maxChunkZ-c.minChunkZ+1,cell=Math.max(2,Math.min(canvas.width/sx,canvas.height/sz));for(const [x,z] of c.chunks){ctx.fillStyle='#5aa7ff';ctx.fillRect((x-c.minChunkX)*cell,(z-c.minChunkZ)*cell,Math.max(1,cell-1),Math.max(1,cell-1));}}
function showInspection(i){lastInspection=i;if(i.bounds)applyBounds(i.bounds);drawCoverage(i.coverage);if(i.coverage)$('coverageInfo').textContent='受信済み '+i.coverage.covered+' chunks / 範囲内欠損 '+i.coverage.missing+' chunks';$('analysis').textContent=JSON.stringify(i,null,2);}
$('file').addEventListener('change',async e=>{const f=e.target.files[0];journal=f?await f.text():'';$('fileInfo').textContent=f?f.name+' / '+f.size.toLocaleString()+' bytes':'ライブキャプチャ結果を使用';});
$('captureStart').onclick=async()=>{try{saveSettings();if(!$('host').value.trim()||!$('username').value.trim())throw new Error('host と Profile name は必須です');$('captureStart').disabled=true;$('captureState').textContent='接続中…';const body={host:$('host').value.trim(),port:+$('port').value,username:$('username').value.trim(),offline:$('offline').checked,profilesFolder:$('profiles').value.trim()||undefined,raknetBackend:$('raknet').value};if($('version').value.trim())body.version=$('version').value.trim();const r=await post('/api/capture/start',body);const s=await r.json();journal='';$('captureStop').disabled=false;$('captureState').className='ok';$('captureState').textContent='録画中 '+(s.version||'auto');}catch(e){$('captureState').className='err';$('captureState').textContent=e.message;$('captureStart').disabled=false;}};
$('captureStop').onclick=async()=>{try{$('captureStop').disabled=true;$('captureState').className='muted';$('captureState').textContent='停止・解析中…';const r=await post('/api/capture/stop');const s=await r.json();showInspection(s);$('captureState').className='ok';$('captureState').textContent='停止: '+s.capture.packets.toLocaleString()+' packets';$('fileInfo').textContent='直前のライブキャプチャを使用中';}catch(e){$('captureState').className='err';$('captureState').textContent=e.message;}finally{$('captureStart').disabled=false;}};
$('analyze').onclick=async()=>{try{$('analysis').textContent='解析中…';const body={};if(journal)body.journal=journal;if($('version').value.trim())body.protocolVersion=$('version').value.trim();const r=await post('/api/analyze',body);showInspection(await r.json());}catch(e){$('analysis').textContent=e.message;}};
$('useBounds').onclick=()=>applyBounds(lastInspection&&lastInspection.bounds);
$('download').onclick=async()=>{const b=$('download');try{b.disabled=true;$('status').className='muted';$('status').textContent='変換中…';const body={from:[+$('fx').value,+$('fy').value,+$('fz').value],to:[+$('tx').value,+$('ty').value,+$('tz').value],strict:$('strict').checked,includeAir:$('air').checked,includeEntities:$('entities').checked,compressed:$('gzip').checked,dataVersion:+$('dv').value,unsupported:$('unsupported').value};if(journal)body.journal=journal;if($('version').value.trim())body.protocolVersion=$('version').value.trim();const r=await post('/api/pipeline',body);const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='building.nbt';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);$('status').className='ok';$('status').textContent='完了: '+blob.size.toLocaleString()+' bytes';}catch(e){$('status').className='err';$('status').textContent=e.message;}finally{b.disabled=false;}};
setInterval(async()=>{try{const r=await fetch('/api/capture/status');const s=await r.json();if(s.active){$('captureStart').disabled=true;$('captureStop').disabled=false;$('captureState').className='ok';$('captureState').textContent='録画中: '+s.packets.toLocaleString()+' packets / '+(s.version||'version auto');}else if(!$('captureStop').disabled){$('captureStop').disabled=true;$('captureStart').disabled=false;if(s.last)showInspection(s.last);}}catch{}},1000);
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
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVec3(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isInteger);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function coverage(document: CaptureDocument): CoverageSummary | undefined {
  if (document.blocks.length === 0) return undefined;
  const seen = new Set<string>();
  const chunks: [number, number][] = [];
  let minChunkX = Infinity; let maxChunkX = -Infinity; let minChunkZ = Infinity; let maxChunkZ = -Infinity;
  for (const block of document.blocks) {
    const x = Math.floor(block.pos[0] / 16); const z = Math.floor(block.pos[2] / 16); const key = `${x},${z}`;
    if (seen.has(key)) continue;
    seen.add(key); chunks.push([x, z]);
    minChunkX = Math.min(minChunkX, x); maxChunkX = Math.max(maxChunkX, x); minChunkZ = Math.min(minChunkZ, z); maxChunkZ = Math.max(maxChunkZ, z);
  }
  chunks.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const total = (maxChunkX - minChunkX + 1) * (maxChunkZ - minChunkZ + 1);
  return { covered: chunks.length, missing: total - chunks.length, minChunkX, maxChunkX, minChunkZ, maxChunkZ, chunks };
}

function inspectJournal(journal: string, protocolVersion?: string): CaptureInspection {
  const summary = summarizeJournal(journal);
  try {
    const document = decodeJournalToCapture(journal, { ...(protocolVersion ? { protocolVersion } : {}) });
    if (document.blocks.length === 0) return { summary, blocks: 0, entities: document.entities?.length ?? 0 };
    return {
      summary,
      bounds: captureBounds(document),
      coverage: coverage(document),
      blocks: document.blocks.length,
      entities: document.entities?.length ?? 0,
    };
  } catch (error) {
    return { summary, decodeError: error instanceof Error ? error.message : String(error) };
  }
}

function openUrl(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}

export async function startGui(options: GuiOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  let active: ActiveCapture | undefined;
  let latestJournal: string | undefined;
  let latestVersion: string | undefined;
  let lastCapture: CompletedCapture | undefined;

  const finishCapture = async (entry: ActiveCapture): Promise<CompletedCapture> => {
    try {
      const capture = await entry.session.done;
      const journal = await readFile(entry.path, "utf8");
      latestJournal = journal;
      latestVersion = capture.version;
      const inspected = inspectJournal(journal, capture.version);
      const completed: CompletedCapture = { capture, ...inspected };
      lastCapture = completed;
      return completed;
    } finally {
      if (active === entry) active = undefined;
      await rm(entry.path, { force: true }).catch(() => undefined);
    }
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(HTML), "cache-control": "no-store" });
        res.end(HTML); return;
      }
      if (req.method === "GET" && req.url === "/api/capture/status") {
        json(res, 200, active
          ? { active: true, packets: active.session.packets, version: active.session.version, startedAt: active.session.startedAt }
          : { active: false, ...(lastCapture ? { last: lastCapture } : {}) });
        return;
      }
      if (req.method === "POST" && req.url === "/api/capture/start") {
        if (active) throw new Error("A capture session is already active");
        const body = await readJson(req);
        if (!isRecord(body)) throw new TypeError("capture settings must be an object");
        const captureHost = stringValue(body.host);
        const username = stringValue(body.username);
        if (!captureHost || !username) throw new TypeError("host and username are required");
        const capturePort = integerValue(body.port) ?? 19132;
        if (capturePort < 1 || capturePort > 65535) throw new RangeError("port must be between 1 and 65535");
        const version = stringValue(body.version);
        const profilesFolder = stringValue(body.profilesFolder);
        const backend = body.raknetBackend === "raknet-node" || body.raknetBackend === "raknet-native" ? body.raknetBackend : "jsp-raknet";
        const path = join(tmpdir(), "cbe-r-gui", `capture-${Date.now()}-${randomUUID()}.ndjson`);
        const session = await startBedrockCapture({
          host: captureHost,
          port: capturePort,
          username,
          output: path,
          offline: body.offline === true,
          raknetBackend: backend,
          ...(version ? { version } : {}),
          ...(profilesFolder ? { profilesFolder } : {}),
        });
        const entry: ActiveCapture = { session, path, completion: Promise.resolve(undefined as never) };
        entry.completion = finishCapture(entry);
        void entry.completion.catch(() => undefined);
        active = entry;
        latestJournal = undefined;
        latestVersion = undefined;
        lastCapture = undefined;
        json(res, 200, { active: true, startedAt: session.startedAt, version: session.version }); return;
      }
      if (req.method === "POST" && req.url === "/api/capture/stop") {
        if (!active) {
          if (lastCapture) { json(res, 200, lastCapture); return; }
          throw new Error("No capture session is active");
        }
        const entry = active;
        entry.session.stop("gui");
        json(res, 200, await entry.completion); return;
      }
      if (req.method === "POST" && req.url === "/api/analyze") {
        const body = await readJson(req);
        if (!isRecord(body)) throw new TypeError("request must be an object");
        const supplied = typeof body.journal === "string" ? body.journal : undefined;
        const journal = supplied ?? latestJournal;
        if (!journal) throw new TypeError("No journal is available; upload one or complete a live capture");
        const protocolVersion = stringValue(body.protocolVersion) ?? (supplied ? undefined : latestVersion);
        json(res, 200, inspectJournal(journal, protocolVersion)); return;
      }
      if (req.method === "POST" && req.url === "/api/pipeline") {
        const body = await readJson(req) as Partial<PipelineRequest>;
        if (!isRecord(body) || !isVec3(body.from) || !isVec3(body.to)) throw new TypeError("from and to are required");
        const supplied = typeof body.journal === "string" ? body.journal : undefined;
        const journal = supplied ?? latestJournal;
        if (!journal) throw new TypeError("No journal is available; upload one or complete a live capture");
        const protocolVersion = stringValue(body.protocolVersion) ?? (supplied ? undefined : latestVersion);
        const document = decodeJournalToCapture(journal, { strict: body.strict ?? false, ...(protocolVersion ? { protocolVersion } : {}) });
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
  return {
    url,
    close: async () => {
      if (active) {
        const entry = active;
        entry.session.stop("gui-close");
        await entry.completion.catch(() => undefined);
      }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
