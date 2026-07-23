/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

interface LooseClient {
  on(event: string, listener: (...args: unknown[]) => void): this;
  close(): void;
}

interface BedrockProtocolModule {
  createClient(options: Record<string, unknown>): LooseClient;
}

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
}

export interface PacketJournalRecord {
  readonly type: "header" | "event" | "packet" | "footer";
  readonly time: string;
  readonly name?: string;
  readonly data?: unknown;
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

export async function captureBedrockSession(options: LiveCaptureOptions): Promise<CaptureSummary> {
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
    },
  });

  const bedrock = require("bedrock-protocol") as BedrockProtocolModule;
  const clientOptions: Record<string, unknown> = {
    host: options.host,
    port: options.port ?? 19132,
    username: options.username,
    offline: options.offline ?? false,
    connectTimeout: options.connectTimeoutMs ?? 15_000,
    raknetBackend: options.raknetBackend ?? "jsp-raknet",
  };
  if (options.version) clientOptions.version = options.version;
  if (options.profilesFolder) clientOptions.profilesFolder = resolve(options.profilesFolder);

  let packets = 0;
  let settled = false;
  let closeReason = "closed";
  let timeout: NodeJS.Timeout | undefined;

  return await new Promise<CaptureSummary>((resolvePromise, rejectPromise) => {
    const client = bedrock.createClient(clientOptions);

    const finish = async (reason: string, error?: unknown): Promise<void> => {
      if (settled) return;
      settled = true;
      closeReason = reason;
      if (timeout) clearTimeout(timeout);
      const endedAt = new Date().toISOString();
      try {
        await writer.append({ type: "footer", time: endedAt, data: { packets, closeReason } });
        await writer.flush();
      } catch (writeError) {
        rejectPromise(writeError);
        return;
      }
      if (error) {
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      } else {
        resolvePromise({ output, packets, startedAt, endedAt, closeReason });
      }
    };

    client.on("status", (status) => {
      void writer.append({ type: "event", time: new Date().toISOString(), name: "status", data: status });
    });
    client.on("join", () => {
      void writer.append({ type: "event", time: new Date().toISOString(), name: "join" });
    });
    client.on("spawn", () => {
      void writer.append({ type: "event", time: new Date().toISOString(), name: "spawn" });
    });
    client.on("packet", (packet, meta) => {
      packets += 1;
      const packetName = typeof meta === "object" && meta !== null && "name" in meta
        ? String((meta as { name: unknown }).name)
        : "unknown";
      void writer.append({ type: "packet", time: new Date().toISOString(), name: packetName, data: packet });
    });
    client.on("kick", (reason) => {
      void writer.append({ type: "event", time: new Date().toISOString(), name: "kick", data: reason });
      void finish("kick");
    });
    client.on("error", (error) => {
      void writer.append({ type: "event", time: new Date().toISOString(), name: "error", data: error });
      void finish("error", error);
    });
    client.on("close", () => void finish(closeReason));

    const stop = (): void => {
      closeReason = "signal";
      client.close();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    if (options.durationMs && options.durationMs > 0) {
      timeout = setTimeout(() => {
        closeReason = "duration";
        client.close();
      }, options.durationMs);
    }
  });
}
