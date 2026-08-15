/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { decodeRuntimeSubChunk } from "../src/raw-chunk.js";

function unsignedVarInt(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function zigZagVarInt(value: number): Buffer {
  return unsignedVarInt(((value << 1) ^ (value >> 31)) >>> 0);
}

test("decodes a version 9 singleton runtime palette", () => {
  const payload = Buffer.concat([
    Buffer.from([9, 1, 0xff, 1]),
    zigZagVarInt(5),
  ]);
  const decoded = decodeRuntimeSubChunk(payload, 2, -3, 0, (runtimeId) => ({
    name: runtimeId === 5 ? "minecraft:stone" : "minecraft:air",
  }));

  assert.equal(decoded.sectionY, -1);
  assert.equal(decoded.bytesRead, payload.length);
  assert.equal(decoded.blocks.length, 4096);
  assert.deepEqual(decoded.blocks[0], {
    pos: [32, -16, -48],
    block: { name: "minecraft:stone" },
  });
  assert.deepEqual(decoded.blocks.at(-1), {
    pos: [47, -1, -33],
    block: { name: "minecraft:stone" },
  });
});

test("decodes packed palette indexes in XZY order", () => {
  const words = Buffer.alloc(128 * 4);
  words.writeUInt32LE(1, 0);
  const payload = Buffer.concat([
    Buffer.from([8, 1, 3]),
    words,
    zigZagVarInt(2),
    zigZagVarInt(0),
    zigZagVarInt(1),
  ]);
  const decoded = decodeRuntimeSubChunk(payload, 0, 0, 4, (runtimeId) => ({
    name: runtimeId === 1 ? "minecraft:stone" : "minecraft:air",
  }));

  assert.equal(decoded.blocks[0]?.block.name, "minecraft:stone");
  assert.equal(decoded.blocks[1]?.block.name, "minecraft:air");
  assert.deepEqual(decoded.blocks[1]?.pos, [0, 65, 0]);
});

test("marks water from the second storage as waterlogged", () => {
  const payload = Buffer.concat([
    Buffer.from([9, 2, 0, 1]),
    zigZagVarInt(2),
    Buffer.from([1]),
    zigZagVarInt(3),
  ]);
  const decoded = decodeRuntimeSubChunk(payload, 0, 0, 0, (runtimeId) => {
    if (runtimeId === 2) return { name: "minecraft:oak_stairs", states: { weirdo_direction: 0 } };
    if (runtimeId === 3) return { name: "minecraft:water" };
    return { name: "minecraft:air" };
  });
  assert.equal(decoded.blocks[0]?.block.states?.waterlogged_bit, true);
});
