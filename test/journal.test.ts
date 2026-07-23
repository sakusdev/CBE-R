/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeJournalToCapture,
  extractChunkJournal,
  parseJournalLine,
  summarizeJournal,
} from "../src/journal.js";
import { serializeJournalRecord } from "../src/live.js";

const journal = [
  JSON.stringify({ event: "packet", name: "start_game", params: {} }),
  JSON.stringify({ event: "packet", name: "level_chunk", params: { x: 1, z: 2 } }),
  JSON.stringify({ event: "packet", name: "sub_chunk", params: { x: 1, z: 2 } }),
  "not-json",
  "",
].join("\n");

test("summarizes packet journals", () => {
  assert.deepEqual(summarizeJournal(journal), {
    records: 4,
    packets: 3,
    chunkPackets: 2,
    malformedLines: 1,
    packetNames: { start_game: 1, level_chunk: 1, sub_chunk: 1 },
  });
});

test("extracts chunk-related packet records", () => {
  const records = extractChunkJournal(journal);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.name, "level_chunk");
  assert.equal(records[1]?.name, "sub_chunk");
});

test("hydrates legacy Buffer and BigInt journal wrappers", () => {
  const record = parseJournalLine(JSON.stringify({
    event: "packet",
    name: "level_chunk",
    params: {
      payload: { type: "Buffer", data: Buffer.from([1, 2, 3]).toString("base64") },
      runtimeId: { type: "BigInt", data: "42" },
    },
  }));
  const params = record.params as { payload: Buffer; runtimeId: bigint };
  assert.deepEqual(params.payload, Buffer.from([1, 2, 3]));
  assert.equal(params.runtimeId, 42n);
});

test("normalizes records emitted by the live recorder", () => {
  const line = serializeJournalRecord({
    type: "packet",
    time: "2026-01-01T00:00:00.000Z",
    name: "level_chunk",
    data: {
      payload: Buffer.from([1, 2, 3]),
      runtimeId: 42n,
      blocks: [{ pos: [1, 2, 3], block: { name: "minecraft:stone" } }],
    },
  });
  const record = parseJournalLine(line);
  const params = record.params as { payload: Buffer; runtimeId: bigint };
  assert.equal(record.type, "packet");
  assert.deepEqual(params.payload, Buffer.from([1, 2, 3]));
  assert.equal(params.runtimeId, 42n);
  assert.equal(extractChunkJournal(line).length, 1);
  assert.equal(decodeJournalToCapture(line, { strict: true }).blocks.length, 1);
});

test("reads a pinned protocol version from the live journal header", () => {
  const header = serializeJournalRecord({
    type: "header",
    time: "2026-01-01T00:00:00.000Z",
    data: { requestedVersion: "1.21.80" },
  });
  const packet = serializeJournalRecord({
    type: "packet",
    time: "2026-01-01T00:00:01.000Z",
    name: "level_chunk",
    data: {},
  });
  let seenVersion: string | undefined;
  decodeJournalToCapture(header + packet, {
    decoders: [{
      id: "version-probe",
      versions: ["1.21.80"],
      decode(_record, context) {
        seenVersion = context.protocolVersion;
        return undefined;
      },
    }],
  });
  assert.equal(seenVersion, "1.21.80");
});

test("decodes normalized block arrays from chunk packets", () => {
  const text = JSON.stringify({
    event: "packet",
    name: "level_chunk",
    params: {
      blocks: [
        { pos: [1, 2, 3], block: { name: "minecraft:stone" } },
        { pos: [1, 2, 3], block: { name: "minecraft:dirt" } },
      ],
      entities: [{ pos: [1.5, 3, 3.5], nbt: { id: "minecraft:armor_stand" } }],
    },
  });
  const capture = decodeJournalToCapture(text, { strict: true });
  assert.equal(capture.blocks.length, 1);
  assert.equal(capture.blocks[0]?.block.name, "minecraft:dirt");
  assert.equal(capture.entities?.length, 1);
});

test("strict decoding rejects journals without supported data", () => {
  assert.throws(() => decodeJournalToCapture(journal, { strict: true }), /Malformed journal line|No supported chunk data/);
});
