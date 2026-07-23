/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { encodeJavaStructure, encodeJavaStructureGzip } from "../src/index.js";

const fixture = {
  dataVersion: 3955,
  size: [2, 1, 1] as const,
  blocks: [
    { pos: [0, 0, 0] as const, state: { name: "minecraft:stone" as const } },
    {
      pos: [1, 0, 0] as const,
      state: {
        name: "minecraft:oak_stairs" as const,
        properties: { facing: "north", half: "bottom", shape: "straight", waterlogged: "false" },
      },
    },
  ],
};

test("encodes a Java structure root compound", () => {
  const encoded = encodeJavaStructure(fixture);
  assert.equal(encoded[0], 10);
  assert.ok(encoded.includes(Buffer.from("DataVersion")));
  assert.ok(encoded.includes(Buffer.from("minecraft:oak_stairs")));
});

test("gzip output expands to the uncompressed NBT", () => {
  assert.deepEqual(gunzipSync(encodeJavaStructureGzip(fixture)), encodeJavaStructure(fixture));
});

test("rejects blocks outside the declared size", () => {
  assert.throws(
    () => encodeJavaStructure({ ...fixture, blocks: [{ ...fixture.blocks[0]!, pos: [2, 0, 0] }] }),
    /outside/,
  );
});
