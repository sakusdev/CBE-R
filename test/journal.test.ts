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

test("hydrates Buffer and BigInt journal wrappers", () => {
  const record = parseJournalLine(JSON.stringify({
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
