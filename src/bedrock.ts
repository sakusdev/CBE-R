/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { JavaBlockState } from "./types.js";

export type BedrockStateValue = string | number | boolean;

export interface BedrockBlockState {
  readonly name: string;
  readonly states?: Readonly<Record<string, BedrockStateValue>>;
}

export type UnsupportedBlockPolicy = "barrier" | "air" | "throw";

export interface ConvertBedrockOptions {
  readonly unsupportedBlockPolicy?: UnsupportedBlockPolicy;
}

const NAME_ALIASES: Readonly<Record<string, string>> = {
  "minecraft:grass": "minecraft:grass_block",
  "minecraft:brick_block": "minecraft:bricks",
  "minecraft:lit_furnace": "minecraft:furnace",
  "minecraft:standing_sign": "minecraft:oak_sign",
  "minecraft:wall_sign": "minecraft:oak_wall_sign",
  "minecraft:wooden_door": "minecraft:oak_door",
  "minecraft:trapdoor": "minecraft:oak_trapdoor",
  "minecraft:waterlily": "minecraft:lily_pad",
};

const STAIR_DIRECTIONS: Readonly<Record<number, string>> = {
  0: "east",
  1: "west",
  2: "south",
  3: "north",
};

const CARDINAL_DIRECTIONS: Readonly<Record<number, string>> = {
  0: "south",
  1: "west",
  2: "north",
  3: "east",
};

function namespaced(name: string): `minecraft:${string}` {
  const value = name.includes(":") ? name : `minecraft:${name}`;
  return (NAME_ALIASES[value] ?? value) as `minecraft:${string}`;
}

function bool(value: BedrockStateValue | undefined): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function text(states: Readonly<Record<string, BedrockStateValue>>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = states[key];
    if (value !== undefined) return String(value);
  }
  return undefined;
}

function facing(states: Readonly<Record<string, BedrockStateValue>>): string {
  const direction = Number(states.direction ?? states.cardinal_direction);
  return CARDINAL_DIRECTIONS[direction] ?? text(states, "minecraft:cardinal_direction", "facing_direction") ?? "north";
}

function unsupported(block: BedrockBlockState, policy: UnsupportedBlockPolicy): JavaBlockState {
  if (policy === "throw") throw new Error(`Unsupported Bedrock block state: ${block.name}`);
  return { name: policy === "air" ? "minecraft:air" : "minecraft:barrier" };
}

/** Converts one normalized Bedrock block state into a Java block state. */
export function convertBedrockBlockState(
  block: BedrockBlockState,
  options: ConvertBedrockOptions = {},
): JavaBlockState {
  const policy = options.unsupportedBlockPolicy ?? "barrier";
  const name = namespaced(block.name);
  const states = block.states ?? {};

  if (name === "minecraft:log" || name === "minecraft:log2") {
    const woodType = text(states, "old_log_type", "new_log_type");
    if (woodType) return { name: namespaced(`${woodType}_log`), properties: { axis: text(states, "pillar_axis") ?? "y" } };
  }

  if (name.endsWith("_log") || name.endsWith("_wood") || name.endsWith("_stem") || name.endsWith("_hyphae")) {
    return { name, properties: { axis: text(states, "pillar_axis") ?? "y" } };
  }

  if (name.endsWith("_slab")) {
    const half = text(states, "minecraft:vertical_half", "vertical_half") ?? "bottom";
    return { name, properties: { type: bool(states.double_slab_bit) ? "double" : half === "top" ? "top" : "bottom", waterlogged: "false" } };
  }

  if (name.endsWith("_stairs")) {
    const stairFacing = STAIR_DIRECTIONS[Number(states.weirdo_direction)] ?? "north";
    return { name, properties: { facing: stairFacing, half: bool(states.upside_down_bit) ? "top" : "bottom", shape: "straight", waterlogged: "false" } };
  }

  if (name.endsWith("_door")) {
    return { name, properties: {
      facing: facing(states),
      half: bool(states.upper_block_bit) ? "upper" : "lower",
      hinge: bool(states.door_hinge_bit) ? "right" : "left",
      open: String(bool(states.open_bit)),
      powered: String(bool(states.powered_bit)),
    } };
  }

  if (name.endsWith("_trapdoor")) {
    return { name, properties: {
      facing: facing(states),
      half: bool(states.upside_down_bit) ? "top" : "bottom",
      open: String(bool(states.open_bit)),
      powered: String(bool(states.powered_bit)),
      waterlogged: "false",
    } };
  }

  if (name.endsWith("_fence") || name.endsWith("_wall") || name === "minecraft:iron_bars" || name.endsWith("_pane")) {
    const properties: Record<string, string> = { north: "false", east: "false", south: "false", west: "false", waterlogged: "false" };
    if (name.endsWith("_wall")) properties.up = "true";
    return { name, properties };
  }

  if (name.endsWith("_button")) return { name, properties: { face: "wall", facing: facing(states), powered: String(bool(states.button_pressed_bit)) } };
  if (name.endsWith("_pressure_plate")) return { name, properties: { powered: String(bool(states.redstone_signal)) } };

  if (name === "minecraft:chest" || name === "minecraft:trapped_chest" || name === "minecraft:barrel" || name.endsWith("_furnace") || name === "minecraft:furnace") {
    const properties: Record<string, string> = { facing: facing(states) };
    if (name.includes("chest")) properties.type = "single";
    return { name, properties };
  }

  if (name.endsWith("_sign") || name.endsWith("_hanging_sign")) {
    return { name, properties: { rotation: String(Number(states.ground_sign_direction ?? 0) & 15), waterlogged: "false" } };
  }

  if (name.endsWith("_wall_sign") || name.endsWith("_wall_hanging_sign")) {
    return { name, properties: { facing: facing(states), waterlogged: "false" } };
  }

  if (name === "minecraft:water" || name === "minecraft:flowing_water") return { name: "minecraft:water", properties: { level: String(Number(states.liquid_depth ?? 0) & 15) } };
  if (name === "minecraft:lava" || name === "minecraft:flowing_lava") return { name: "minecraft:lava", properties: { level: String(Number(states.liquid_depth ?? 0) & 15) } };

  if (name.endsWith("_leaves") || name.endsWith("_leaves2")) {
    return { name: name.replace("_leaves2", "_leaves") as `minecraft:${string}`, properties: { distance: "7", persistent: String(bool(states.persistent_bit)), waterlogged: "false" } };
  }

  if (name.endsWith("_sapling")) return { name, properties: { stage: bool(states.age_bit) ? "1" : "0" } };
  if (name === "minecraft:snow_layer") return { name: "minecraft:snow", properties: { layers: String(Math.min(8, Number(states.height ?? 0) + 1)) } };

  // Most modern Bedrock identifiers match Java identifiers. Preserve state-less
  // blocks directly, while stateful unknowns use the configured safe fallback.
  if (Object.keys(states).length === 0) return { name };

  return unsupported(block, policy);
}
