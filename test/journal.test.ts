/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { extractChunkJournal, summarizeJournal } from "../src/journal.js";

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
