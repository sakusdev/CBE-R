/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { encodeJavaStructureGzip, extractJavaStructure, validateCaptureDocument } from "../src/index.js";
import type { CaptureDocument } from "../src/index.js";

const capture: CaptureDocument = {
  format: "cbe-r-capture",
  version: 1,
  blocks: [
    { pos: [10, 64, 10], block: { name: "minecraft:stone" } },
    { pos: [11, 64, 10], block: { name: "minecraft:oak_fence" } },
    { pos: [12, 64, 10], block: { name: "minecraft:oak_planks" } },
    {
      pos: [10, 65, 10],
      block: { name: "minecraft:chest", states: { direction: 2 } },
      blockEntity: { id: "minecraft:chest", CustomName: "Test" },
    },
  ],
  entities: [
    { pos: [10.5, 65, 10.5], nbt: { id: "minecraft:armor_stand", Invisible: false } },
  ],
};

test("validates capture documents", () => {
  const value: unknown = JSON.parse(JSON.stringify(capture));
  validateCaptureDocument(value);
  assert.equal(value.blocks.length, 4);
});

test("extracts and offsets a selected range", () => {
  const structure = extractJavaStructure(capture, [10, 64, 10], [12, 65, 10], { includeEntities: true });
  assert.deepEqual(structure.size, [3, 2, 1]);
  assert.equal(structure.blocks.length, 4);
  assert.deepEqual(structure.blocks[0]?.pos, [0, 0, 0]);
  assert.equal(structure.entities?.length, 1);
  assert.ok(encodeJavaStructureGzip(structure).length > 0);
});

test("resolves fence connections", () => {
  const structure = extractJavaStructure(capture, [10, 64, 10], [12, 64, 10]);
  const fence = structure.blocks.find(({ state }) => state.name === "minecraft:oak_fence");
  assert.equal(fence?.state.properties?.west, "true");
  assert.equal(fence?.state.properties?.east, "true");
});

test("can omit unsupported states as air", () => {
  const document: CaptureDocument = {
    format: "cbe-r-capture",
    version: 1,
    blocks: [{ pos: [0, 0, 0], block: { name: "minecraft:unknown", states: { custom: 1 } } }],
  };
  const structure = extractJavaStructure(document, [0, 0, 0], [0, 0, 0], { unsupportedBlockPolicy: "air" });
  assert.equal(structure.blocks.length, 0);
});
