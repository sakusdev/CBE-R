/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import clientModuleValue from "bedrock-protocol/src/client.js";
import initRaknetValue from "bedrock-protocol/src/rak.js";
import protocolOptionsValue from "bedrock-protocol/src/options.js";
import advertisementValue from "bedrock-protocol/src/server/advertisement.js";

interface LooseClient {
  options: Record<string, unknown>;
  readonly viewDistance?: number;
  tick?: bigint;
  on(event: string, listener: (...args: unknown[]) => void): this;
  once(event: string, listener: (...args: unknown[]) => void): this;
  emit(event: string, ...args: unknown[]): boolean;
  init(): void;
  connect(): void;
  close(): void;
  queue(name: string, params: Record<string, unknown>): void;
  write(name: string, params: Record<string, unknown>): void;
  versionLessThanOrEqualTo(version: string): boolean;
}

interface ClientModule {
  readonly Client: new (options: Record<string, unknown>) => LooseClient;
}

interface RakClientLike {
  ping(timeout?: number): Promise<string>;
  close(): void;
}

interface RakModule {
  readonly RakClient: new (options: Record<string, unknown>, client?: unknown) => RakClientLike;
}

type RakInitializer = (backend: string) => RakModule;

interface ProtocolOptionsModule {
  readonly CURRENT_VERSION: string;
  readonly Versions: Readonly<Record<string, unknown>>;
}

interface ServerAdvertisement {
  readonly version?: string;
  readonly portV4?: number | null;
  readonly motd?: string;
  readonly levelName?: string;
}

interface AdvertisementModule {
  fromServerName(value: string): ServerAdvertisement;
}

const Client = (clientModuleValue as ClientModule).Client;
const initRaknet = initRaknetValue as RakInitializer;
const protocolOptions = protocolOptionsValue as ProtocolOptionsModule;
const advertisement = advertisementValue as AdvertisementModule;

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
  const version = client.options.version;
  if (typeof version === "string" && version.length > 0) return version;
  if (typeof version === "number" && Number.isFinite(version)) return String(version);
  return undefined;
}

function selectedRaknetBackend(options: LiveCaptureOptions): "jsp-raknet" | "raknet-node" | "raknet-native" {
  return options.raknetBackend ?? "jsp-raknet";
}

async function pingBedrockServer(options: LiveCaptureOptions): Promise<ServerAdvertisement> {
  const backend = selectedRaknetBackend(options);
  const { RakClient } = initRaknet(backend);
  // Workers require an external worker file. Keep the pure-JS backend in-process so Bun standalone executables stay self-contained.
  const connection = new RakClient({
    host: options.host,
    port: options.port ?? 19132,
    useWorkers: false,
  });
  try {
    return advertisement.fromServerName(await connection.ping(options.connectTimeoutMs ?? 15_000));
  } finally {
    connection.close();
  }
}

function connectBedrockClient(client: LooseClient): void {
  client.connect();

  client.on("network_stack_latency", (packet) => {
    if (isRecord(packet) && packet.needs_response === true) {
      client.queue("network_stack_latency", {
        timestamp: packet.timestamp,
        needs_response: false,
      });
    }
  });

  client.once("resource_packs_info", () => {
    client.write("resource_pack_client_response", {
      response_status: "completed",
      response_status_name: "resourcepackstackfinished",
      resourcepackids: [],
    });

    client.once("resource_pack_stack", () => {
      client.write("resource_pack_client_response", {
        response_status: "completed",
        response_status_name: "resourcepackstackfinished",
        resourcepackids: [],
      });
    });

    // CBE-R needs self-contained raw chunk payloads, not cache blob references.
    client.queue("client_cache_status", { enabled: false });

    if (client.versionLessThanOrEqualTo("1.20.80")) {
      client.queue("tick_sync", { request_time: BigInt(Date.now()), response_time: 0n });
    }

    setTimeout(() => {
      client.queue("request_chunk_radius", { chunk_radius: client.viewDistance ?? 10 });
    }, 500);
  });

  if (client.versionLessThanOrEqualTo("1.20.80")) {
    const keepAliveInterval = 10n;
    let timer: NodeJS.Timeout | undefined;
    client.tick = 0n;
    client.once("spawn", () => {
      timer = setInterval(() => {
        client.queue("tick_sync", { request_time: client.tick ?? 0n, response_time: 0n });
        client.tick = (client.tick ?? 0n) + keepAliveInterval;
      }, 500);
      client.on("tick_sync", (packet) => {
        if (isRecord(packet) && typeof packet.response_time === "bigint") client.tick = packet.response_time;
      });
    });
    client.once("close", () => {
      if (timer) clearInterval(timer);
    });
  }
}

async function initializeBedrockClient(client: LooseClient, options: LiveCaptureOptions): Promise<void> {
  if (!options.version) {
    const server = await pingBedrockServer(options);
    client.emit("status", server);
    const advertised = server.version?.split(".").slice(0, 3).join(".");
    client.options.version = advertised && Object.prototype.hasOwnProperty.call(protocolOptions.Versions, advertised)
      ? advertised
      : protocolOptions.CURRENT_VERSION;
    if (typeof server.portV4 === "number" && client.options.followPort === true) client.options.port = server.portV4;
  }

  client.on("connect_allowed", () => connectBedrockClient(client));
  client.init();
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
    raknetBackend: selectedRaknetBackend(options),
    useRaknetWorkers: false,
    enableChunkCaching: false,
    followPort: true,
    delayedInit: true,
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

  const client = new Client(clientOptions);
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

  // Initialize after all journal/error listeners are installed. Unlike bedrock-protocol's public createClient(),
  // this path never eagerly loads raknet-native and uses the selected backend for both ping and gameplay.
  void initializeBedrockClient(client, options).catch((error: unknown) => client.emit("error", error));

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
