/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CaptureBlock, CaptureDocument, CaptureEntity } from "./types.js";

export interface JournalPacketRecord {
  readonly time?: string;
  readonly event?: string;
  readonly name?: string;
  readonly params?: unknown;
  readonly version?: string;
  readonly [key: string]: unknown;
}

export interface JournalSummary {
  readonly records: number;
  readonly packets: number;
  readonly chunkPackets: number;
  readonly malformedLines: number;
  readonly packetNames: Readonly<Record<string, number>>;
}

export interface DecodeContext {
  readonly protocolVersion?: string;
  readonly records: readonly JournalPacketRecord[];
}

export interface JournalDecoder {
  readonly id: string;
  readonly versions: readonly string[] | "*";
  decode(record: JournalPacketRecord, context: DecodeContext): Partial<CaptureDocument> | undefined;
}

export interface DecodeJournalOptions {
  readonly protocolVersion?: string;
  readonly strict?: boolean;
  readonly decoders?: readonly JournalDecoder[];
}

const CHUNK_PACKET_NAMES = new Set([
  "level_chunk",
  "sub_chunk",
  "sub_chunk_request",
  "client_cache_blob_status",
  "client_cache_miss_response",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Restores Buffer and BigInt wrappers emitted by serializeJournalRecord. */
export function hydrateJournalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateJournalValue);
  if (!isRecord(value)) return value;

  if (value.type === "Buffer" && typeof value.data === "string") {
    return Buffer.from(value.data, "base64");
  }
  if (value.type === "BigInt" && typeof value.data === "string") {
    return BigInt(value.data);
  }
  if (value.type === "Circular") return undefined;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, hydrateJournalValue(entry)]),
  );
}

export function parseJournalLine(line: string): JournalPacketRecord {
  const value: unknown = hydrateJournalValue(JSON.parse(line));
  if (!isRecord(value)) throw new TypeError("Journal line must contain a JSON object");
  return value as JournalPacketRecord;
}

export function isChunkPacket(record: JournalPacketRecord): boolean {
  return typeof record.name === "string" && CHUNK_PACKET_NAMES.has(record.name);
}

export function parseJournal(text: string, strict = false): JournalPacketRecord[] {
  const records: JournalPacketRecord[] = [];
  for (const [index, rawLine] of text.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      records.push(parseJournalLine(line));
    } catch (error) {
      if (strict) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(`Malformed journal line ${index + 1}: ${message}`);
      }
    }
  }
  return records;
}

export function summarizeJournal(text: string): JournalSummary {
  let records = 0;
  let packets = 0;
  let chunkPackets = 0;
  let malformedLines = 0;
  const packetNames: Record<string, number> = {};

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    records += 1;
    try {
      const record = parseJournalLine(line);
      if (typeof record.name === "string") {
        packets += 1;
        packetNames[record.name] = (packetNames[record.name] ?? 0) + 1;
        if (isChunkPacket(record)) chunkPackets += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { records, packets, chunkPackets, malformedLines, packetNames };
}

export function extractChunkJournal(text: string): JournalPacketRecord[] {
  return parseJournal(text).filter(isChunkPacket);
}

function validCaptureBlock(value: unknown): value is CaptureBlock {
  if (!isRecord(value) || !Array.isArray(value.pos) || value.pos.length !== 3 || !isRecord(value.block)) return false;
  return value.pos.every(Number.isInteger) && typeof value.block.name === "string";
}

function validCaptureEntity(value: unknown): value is CaptureEntity {
  return isRecord(value)
    && Array.isArray(value.pos)
    && value.pos.length === 3
    && value.pos.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    && isRecord(value.nbt);
}

/**
 * Decoder for adapters/fixtures that attach normalized `blocks` and `entities`
 * arrays directly to level_chunk or sub_chunk packet params.
 */
export const normalizedPacketDecoder: JournalDecoder = {
  id: "normalized-packet-v1",
  versions: "*",
  decode(record) {
    if (!isChunkPacket(record) || !isRecord(record.params)) return undefined;
    const blocks = Array.isArray(record.params.blocks) ? record.params.blocks.filter(validCaptureBlock) : [];
    const entities = Array.isArray(record.params.entities) ? record.params.entities.filter(validCaptureEntity) : [];
    if (blocks.length === 0 && entities.length === 0) return undefined;
    return {
      format: "cbe-r-capture",
      version: 1,
      blocks,
      ...(entities.length > 0 ? { entities } : {}),
    };
  },
};

export function decodeJournalToCapture(text: string, options: DecodeJournalOptions = {}): CaptureDocument {
  const records = parseJournal(text, options.strict ?? false);
  const protocolVersion = options.protocolVersion
    ?? records.find((record) => typeof record.version === "string")?.version;
  const decoders = options.decoders ?? [normalizedPacketDecoder];
  const blocks = new Map<string, CaptureBlock>();
  const entities: CaptureEntity[] = [];
  let dimension: string | undefined;

  for (const record of records) {
    for (const decoder of decoders) {
      if (decoder.versions !== "*" && (!protocolVersion || !decoder.versions.includes(protocolVersion))) continue;
      const partial = decoder.decode(record, { protocolVersion, records });
      if (!partial) continue;
      if (partial.dimension) dimension = partial.dimension;
      for (const block of partial.blocks ?? []) blocks.set(block.pos.join(","), block);
      entities.push(...(partial.entities ?? []));
    }
  }

  if (blocks.size === 0 && entities.length === 0 && (options.strict ?? false)) {
    throw new Error("No supported chunk data was decoded from the journal");
  }

  return {
    format: "cbe-r-capture",
    version: 1,
    ...(dimension ? { dimension } : {}),
    blocks: [...blocks.values()],
    ...(entities.length > 0 ? { entities } : {}),
  };
}
