/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { captureBounds, regionFilename, splitBounds } from "../src/planning.js";
import type { CaptureDocument } from "../src/types.js";

test("detects capture bounds", () => {
  const document: CaptureDocument = {
    format: "cbe-r-capture",
    version: 1,
    blocks: [
      { pos: [10, -2, 30], block: { name: "minecraft:stone" } },
      { pos: [42, 80, -5], block: { name: "minecraft:dirt" } },
    ],
  };
  assert.deepEqual(captureBounds(document), [[10, -2, -5], [42, 80, 30]]);
});

test("splits bounds without gaps", () => {
  const regions = splitBounds([0, 0, 0], [63, 47, 63], [32, 48, 32]);
  assert.equal(regions.length, 4);
  assert.deepEqual(regions[0], { from: [0, 0, 0], to: [31, 47, 31], index: [0, 0, 0] });
  assert.deepEqual(regions[3], { from: [32, 0, 32], to: [63, 47, 63], index: [1, 0, 1] });
});

test("creates deterministic region filenames", () => {
  assert.equal(regionFilename("castle.nbt", [1, 2, 3]), "castle_1_2_3.nbt");
  assert.equal(regionFilename("castle", [0, 0, 0]), "castle_0_0_0.nbt");
});
