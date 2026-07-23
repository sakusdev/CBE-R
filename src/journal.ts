/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export interface JournalPacketRecord {
  readonly time?: string;
  readonly event?: string;
  readonly name?: string;
  readonly params?: unknown;
  readonly [key: string]: unknown;
}

export interface JournalSummary {
  readonly records: number;
  readonly packets: number;
  readonly chunkPackets: number;
  readonly malformedLines: number;
  readonly packetNames: Readonly<Record<string, number>>;
}

const CHUNK_PACKET_NAMES = new Set(["level_chunk", "sub_chunk", "sub_chunk_request", "client_cache_blob_status", "client_cache_miss_response"]);

export function parseJournalLine(line: string): JournalPacketRecord {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Journal line must contain a JSON object");
  }
  return value as JournalPacketRecord;
}

export function isChunkPacket(record: JournalPacketRecord): boolean {
  return typeof record.name === "string" && CHUNK_PACKET_NAMES.has(record.name);
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
  const result: JournalPacketRecord[] = [];
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const record = parseJournalLine(line);
      if (isChunkPacket(record)) result.push(record);
    } catch {
      // Malformed lines are intentionally ignored here; summarizeJournal reports them.
    }
  }
  return result;
}
