/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JavaBlockState } from "./types.js";

export type BedrockStateValue = string | number | boolean;

export interface BedrockBlockState {
  readonly name: string;
  readonly states?: Readonly<Record<string, BedrockStateValue>>;
}

export type UnsupportedBlockPolicy = "barrier" | "throw";

export interface ConvertBedrockOptions {
  readonly unsupportedBlockPolicy?: UnsupportedBlockPolicy;
}

const STATELESS_BLOCKS = new Set([
  "minecraft:air",
  "minecraft:stone",
  "minecraft:dirt",
  "minecraft:grass_block",
  "minecraft:cobblestone",
  "minecraft:glass",
  "minecraft:bricks",
  "minecraft:oak_planks",
  "minecraft:spruce_planks",
  "minecraft:birch_planks",
  "minecraft:jungle_planks",
  "minecraft:acacia_planks",
  "minecraft:dark_oak_planks",
  "minecraft:mangrove_planks",
  "minecraft:cherry_planks",
]);

const STAIR_DIRECTIONS: Readonly<Record<number, string>> = {
  0: "east",
  1: "west",
  2: "south",
  3: "north",
};

function namespaced(name: string): `minecraft:${string}` {
  return (name.includes(":") ? name : `minecraft:${name}`) as `minecraft:${string}`;
}

function booleanState(value: BedrockStateValue | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function stringState(
  states: Readonly<Record<string, BedrockStateValue>>,
  key: string,
): string | undefined {
  const value = states[key];
  return value === undefined ? undefined : String(value);
}

function unsupported(
  block: BedrockBlockState,
  policy: UnsupportedBlockPolicy,
): JavaBlockState {
  if (policy === "throw") {
    throw new Error(`Unsupported Bedrock block state: ${block.name}`);
  }

  return { name: "minecraft:barrier" };
}

/**
 * Converts a normalized Bedrock block state into the Java block-state model
 * consumed by the structure NBT encoder.
 *
 * Neighbor-dependent properties such as stair shape and fence connections are
 * intentionally left for a later world-resolution pass.
 */
export function convertBedrockBlockState(
  block: BedrockBlockState,
  options: ConvertBedrockOptions = {},
): JavaBlockState {
  const policy = options.unsupportedBlockPolicy ?? "barrier";
  const name = namespaced(block.name);
  const states = block.states ?? {};

  if (STATELESS_BLOCKS.has(name) && Object.keys(states).length === 0) {
    return { name };
  }

  if (name === "minecraft:log" || name === "minecraft:log2") {
    const woodType = stringState(states, "old_log_type") ?? stringState(states, "new_log_type");
    const axis = stringState(states, "pillar_axis") ?? "y";

    if (woodType) {
      return {
        name: namespaced(`${woodType}_log`),
        properties: { axis },
      };
    }
  }

  if (name.endsWith("_log")) {
    return {
      name,
      properties: {
        axis: stringState(states, "pillar_axis") ?? "y",
      },
    };
  }

  if (name.endsWith("_slab")) {
    const verticalHalf = stringState(states, "minecraft:vertical_half")
      ?? stringState(states, "vertical_half")
      ?? "bottom";

    return {
      name,
      properties: {
        type: verticalHalf === "top" ? "top" : "bottom",
        waterlogged: "false",
      },
    };
  }

  if (name.endsWith("_stairs")) {
    const directionValue = Number(states.weirdo_direction);
    const facing = STAIR_DIRECTIONS[directionValue];

    if (facing) {
      return {
        name,
        properties: {
          facing,
          half: booleanState(states.upside_down_bit) ? "top" : "bottom",
          shape: "straight",
          waterlogged: "false",
        },
      };
    }
  }

  return unsupported(block, policy);
}
