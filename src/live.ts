/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as bedrockProtocol from "bedrock-protocol";

interface LooseClient {
  readonly options?: { readonly version?: unknown };
  on(event: string, listener: (...args: unknown[]) => void): this;
  close(): void;
}

interface BedrockProtocolModule {
  createClient(options: Record<string, unknown>): LooseClient;
}

const bedrock = bedrockProtocol as unknown as BedrockProtocolModule;

export interface LiveCaptureOptions {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly output: string;
  readonly version?: string;
  readonly offline?: boolean;
  readonly profilesFolder?: string;
  readonly connectTimeoutMs?: number;
  readonly durationMs?: number;
  readonly raknetBackend?: "jsp-raknet" | "raknet-node" | "raknet-native";
}

export interface CaptureSummary {
  readonly output: string;
  readonly packets: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly closeReason: string;
  readonly version?: string;
}

export interface LiveCaptureSession {
  readonly output: string;
  readonly startedAt: string;
  readonly packets: number;
  readonly version: string | undefined;
  readonly done: Promise<CaptureSummary>;
  stop(reason?: string): void;
}

export interface PacketJournalRecord {
  readonly type: "header" | "event" | "packet" | "footer";
  readonly time: string;
  readonly name?: string;
  readonly data?: unknown;
  readonly version?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return { $circular: true };
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = jsonSafe(entry, seen);
  return output;
}

function negotiatedClientVersion(client: LooseClient): string | undefined {
  const version = client.options?.version;
  if (typeof version === "string" && version.length > 0) return version;
  if (typeof version === "number" && Number.isFinite(version)) return String(version);
  return undefined;
}

/** Normalizes both the current single-deserializer-result event and legacy `(packet, meta)` packet events. */
export function normalizePacketEvent(packet: unknown, meta?: unknown): { name: string; data: unknown } {
  if (isRecord(packet) && isRecord(packet.data)) {
    const name = typeof packet.data.name === "string" ? packet.data.name : undefined;
    if (name && "params" in packet.data) return { name, data: packet.data.params };
  }
  if (isRecord(meta) && typeof meta.name === "string") return { name: meta.name, data: packet };
  if (isRecord(packet) && typeof packet.name === "string") {
    return { name: packet.name, data: "params" in packet ? packet.params : packet };
  }
  return { name: "unknown", data: packet };
}

export function serializeJournalRecord(record: PacketJournalRecord): string {
  return `${JSON.stringify(jsonSafe(record))}\n`;
}

class JournalWriter {
  private chain: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  append(record: PacketJournalRecord): Promise<void> {
    const line = serializeJournalRecord(record);
    this.chain = this.chain.then(() => appendFile(this.path, line, "utf8"));
    return this.chain;
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

/** Starts a capture that can be stopped by the caller without installing process-wide signal handlers. */
export async function startBedrockCapture(options: LiveCaptureOptions): Promise<LiveCaptureSession> {
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, "", "utf8");
  const writer = new JournalWriter(output);
  const startedAt = new Date().toISOString();
  await writer.append({
    type: "header",
    time: startedAt,
    data: {
      format: "cbe-r-packet-journal",
      version: 1,
      host: options.host,
      port: options.port ?? 19132,
      requestedVersion: options.version ?? "auto",
      offline: options.offline ?? false,
      chunkCaching: false,
    },
  });

  const clientOptions: Record<string, unknown> = {
    host: options.host,
    port: options.port ?? 19132,
    username: options.username,
    offline: options.offline ?? false,
    connectTimeout: options.connectTimeoutMs ?? 15_000,
    raknetBackend: options.raknetBackend ?? "jsp-raknet",
    enableChunkCaching: false,
  };
  if (options.version) clientOptions.version = options.version;
  if (options.profilesFolder) clientOptions.profilesFolder = resolve(options.profilesFolder);

  let packets = 0;
  let settled = false;
  let closeReason = "closed";
  let timeout: NodeJS.Timeout | undefined;
  let negotiatedVersion = options.version;
  let resolveDone!: (summary: CaptureSummary) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<CaptureSummary>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });

  const client = bedrock.createClient(clientOptions);
  const finish = async (reason: string, error?: unknown): Promise<void> => {
    if (settled) return;
    settled = true;
    closeReason = reason;
    if (timeout) clearTimeout(timeout);
    negotiatedVersion ??= negotiatedClientVersion(client);
    const endedAt = new Date().toISOString();
    try {
      await writer.append({
        type: "footer",
        time: endedAt,
        data: { packets, closeReason },
        ...(negotiatedVersion ? { version: negotiatedVersion } : {}),
      });
      await writer.flush();
    } catch (writeError) {
      rejectDone(writeError instanceof Error ? writeError : new Error(String(writeError)));
      return;
    }
    if (error) {
      rejectDone(error instanceof Error ? error : new Error(String(error)));
    } else {
      resolveDone({ output, packets, startedAt, endedAt, closeReason, ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
    }
  };

  // createClient resolves auto-versioning from the server ping before emitting connect_allowed.
  client.on("connect_allowed", () => {
    negotiatedVersion ??= negotiatedClientVersion(client);
    void writer.append({ type: "event", time: new Date().toISOString(), name: "connect_allowed", ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
  });
  client.on("status", (status) => {
    void writer.append({ type: "event", time: new Date().toISOString(), name: "status", data: status, ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
  });
  client.on("join", () => {
    void writer.append({ type: "event", time: new Date().toISOString(), name: "join", ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
  });
  client.on("spawn", () => {
    void writer.append({ type: "event", time: new Date().toISOString(), name: "spawn", ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
  });
  client.on("packet", (packet, meta) => {
    packets += 1;
    negotiatedVersion ??= negotiatedClientVersion(client);
    const normalized = normalizePacketEvent(packet, meta);
    void writer.append({
      type: "packet",
      time: new Date().toISOString(),
      name: normalized.name,
      data: normalized.data,
      ...(negotiatedVersion ? { version: negotiatedVersion } : {}),
    });
  });
  client.on("kick", (reason) => {
    void writer.append({ type: "event", time: new Date().toISOString(), name: "kick", data: reason, ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
    void finish("kick");
  });
  client.on("error", (error) => {
    void writer.append({ type: "event", time: new Date().toISOString(), name: "error", data: error, ...(negotiatedVersion ? { version: negotiatedVersion } : {}) });
    void finish("error", error);
  });
  client.on("close", () => void finish(closeReason));

  if (options.durationMs && options.durationMs > 0) {
    timeout = setTimeout(() => {
      closeReason = "duration";
      client.close();
    }, options.durationMs);
  }

  return {
    output,
    startedAt,
    get packets() { return packets; },
    get version() { return negotiatedVersion ?? negotiatedClientVersion(client); },
    done,
    stop(reason = "manual") {
      if (settled) return;
      closeReason = reason;
      client.close();
    },
  };
}

export async function captureBedrockSession(options: LiveCaptureOptions): Promise<CaptureSummary> {
  const session = await startBedrockCapture(options);
  const stop = (): void => session.stop("signal");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await session.done;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
