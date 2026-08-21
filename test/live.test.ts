/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { normalizePacketEvent, serializeJournalRecord } from "../src/live.js";

test("serializes buffers and bigint values in packet journals", () => {
  const line = serializeJournalRecord({
    type: "packet",
    time: "2026-01-01T00:00:00.000Z",
    name: "level_chunk",
    data: { payload: Buffer.from([1, 2, 3]), runtimeId: 42n },
  });
  const parsed = JSON.parse(line) as {
    data: { payload: { $buffer: string }; runtimeId: { $bigint: string } };
  };
  assert.equal(parsed.data.payload.$buffer, "AQID");
  assert.equal(parsed.data.runtimeId.$bigint, "42");
});

test("marks circular packet objects instead of crashing", () => {
  const packet: Record<string, unknown> = {};
  packet.self = packet;
  const line = serializeJournalRecord({ type: "packet", time: "now", data: packet });
  assert.match(line, /\$circular/);
});

test("normalizes current bedrock-protocol deserializer packet events", () => {
  const normalized = normalizePacketEvent({
    data: {
      name: "level_chunk",
      params: { x: 3, z: -4, payload: Buffer.from([9]) },
    },
    metadata: { size: 123 },
  });
  assert.equal(normalized.name, "level_chunk");
  assert.deepEqual(normalized.data, { x: 3, z: -4, payload: Buffer.from([9]) });
});

test("keeps compatibility with legacy packet/meta events", () => {
  const packet = { x: 1, z: 2 };
  assert.deepEqual(normalizePacketEvent(packet, { name: "level_chunk" }), {
    name: "level_chunk",
    data: packet,
  });
});
