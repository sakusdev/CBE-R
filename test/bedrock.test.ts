/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";

import { convertBedrockBlockState } from "../src/bedrock.js";

test("passes through supported stateless blocks", () => {
  assert.deepEqual(convertBedrockBlockState({ name: "stone" }), {
    name: "minecraft:stone",
  });
});

test("converts legacy Bedrock logs", () => {
  assert.deepEqual(
    convertBedrockBlockState({
      name: "minecraft:log",
      states: {
        old_log_type: "spruce",
        pillar_axis: "x",
      },
    }),
    {
      name: "minecraft:spruce_log",
      properties: { axis: "x" },
    },
  );
});

test("converts slab half and adds Java waterlogged state", () => {
  assert.deepEqual(
    convertBedrockBlockState({
      name: "oak_slab",
      states: { vertical_half: "top" },
    }),
    {
      name: "minecraft:oak_slab",
      properties: { type: "top", waterlogged: "false" },
    },
  );
});

test("converts Bedrock stair direction and upside-down bit", () => {
  assert.deepEqual(
    convertBedrockBlockState({
      name: "oak_stairs",
      states: { weirdo_direction: 3, upside_down_bit: true },
    }),
    {
      name: "minecraft:oak_stairs",
      properties: {
        facing: "north",
        half: "top",
        shape: "straight",
        waterlogged: "false",
      },
    },
  );
});

test("uses a barrier for unsupported blocks by default", () => {
  assert.deepEqual(convertBedrockBlockState({ name: "unknown:block" }), {
    name: "minecraft:barrier",
  });
});

test("can reject unsupported blocks", () => {
  assert.throws(
    () => convertBedrockBlockState(
      { name: "unknown:block" },
      { unsupportedBlockPolicy: "throw" },
    ),
    /Unsupported Bedrock block state/,
  );
});
