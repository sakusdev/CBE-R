/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeBlockRegistry } from "../src/runtime-palette.js";

test("ingests indexed start_game block palettes", () => {
  const registry = RuntimeBlockRegistry.fromJournal([{
    event: "packet",
    name: "start_game",
    params: {
      block_properties: [
        { name: "minecraft:air", states: {} },
        { name: "minecraft:stone", states: { stone_type: "stone" } },
      ],
    },
  }]);
  assert.equal(registry.size, 2);
  assert.equal(registry.require(1).name, "minecraft:stone");
  assert.equal(registry.require(1).states?.stone_type, "stone");
});

test("honors explicit runtime IDs and unwraps typed state values", () => {
  const registry = new RuntimeBlockRegistry();
  const added = registry.ingestStartGame({
    type: "packet",
    name: "start_game",
    data: {
      blockPalette: [{
        runtimeId: 42,
        identifier: "minecraft:oak_stairs",
        states: [
          { name: "weirdo_direction", value: { type: "int", value: 3 } },
          { name: "upside_down_bit", value: { type: "byte", value: 1 } },
        ],
      }],
    },
  });
  assert.equal(added, 1);
  assert.deepEqual(registry.require(42), {
    name: "minecraft:oak_stairs",
    states: { weirdo_direction: 3, upside_down_bit: 1 },
  });
});

test("unknown runtime IDs fail explicitly", () => {
  assert.throws(() => new RuntimeBlockRegistry().require(999), /Unknown Bedrock runtime block ID/u);
});
