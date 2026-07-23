/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { convertBedrockBlockState, type ConvertBedrockOptions } from "./bedrock.js";
import type { CaptureBlock, CaptureDocument, JavaBlockState, JavaStructure, StructureBlock, Vec3 } from "./types.js";

export interface ExtractOptions extends ConvertBedrockOptions {
  readonly dataVersion?: number;
  readonly includeAir?: boolean;
  readonly includeEntities?: boolean;
}

function key(pos: Vec3): string {
  return `${pos[0]},${pos[1]},${pos[2]}`;
}

export function normalizeBounds(a: Vec3, b: Vec3): readonly [min: Vec3, max: Vec3] {
  return [
    [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])],
    [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])],
  ];
}

function offset(pos: Vec3, min: Vec3): Vec3 {
  return [pos[0] - min[0], pos[1] - min[1], pos[2] - min[2]];
}

function directionVector(facing: string): Vec3 {
  switch (facing) {
    case "north": return [0, 0, -1];
    case "south": return [0, 0, 1];
    case "west": return [-1, 0, 0];
    default: return [1, 0, 0];
  }
}

function add(pos: Vec3, delta: Vec3): Vec3 {
  return [pos[0] + delta[0], pos[1] + delta[1], pos[2] + delta[2]];
}

function opposite(facing: string): string {
  return { north: "south", south: "north", east: "west", west: "east" }[facing] ?? "north";
}

function sideVectors(facing: string): readonly [Vec3, Vec3] {
  return facing === "north" || facing === "south" ? [[-1, 0, 0], [1, 0, 0]] : [[0, 0, -1], [0, 0, 1]];
}

function resolvesConnection(state: JavaBlockState): boolean {
  const name = state.name;
  return name !== "minecraft:air" && name !== "minecraft:water" && name !== "minecraft:lava" && !name.endsWith("_button");
}

function resolveState(pos: Vec3, state: JavaBlockState, states: ReadonlyMap<string, JavaBlockState>): JavaBlockState {
  const properties = state.properties;
  if (!properties) return state;

  if (state.name.endsWith("_stairs")) {
    const facing = properties.facing ?? "north";
    const half = properties.half ?? "bottom";
    const front = states.get(key(add(pos, directionVector(facing))));
    const back = states.get(key(add(pos, directionVector(opposite(facing)))));
    let shape = "straight";
    const [leftVector, rightVector] = sideVectors(facing);
    const leftName = states.get(key(add(pos, leftVector)))?.name;
    const rightName = states.get(key(add(pos, rightVector)))?.name;

    if (front?.name.endsWith("_stairs") && front.properties?.half === half && front.properties.facing !== facing && front.properties.facing !== opposite(facing)) {
      shape = front.properties.facing === (facing === "north" ? "west" : facing === "south" ? "east" : facing === "west" ? "south" : "north") ? "outer_left" : "outer_right";
    } else if (back?.name.endsWith("_stairs") && back.properties?.half === half && back.properties.facing !== facing && back.properties.facing !== opposite(facing)) {
      shape = back.properties.facing === (facing === "north" ? "west" : facing === "south" ? "east" : facing === "west" ? "south" : "north") ? "inner_left" : "inner_right";
    } else if (leftName?.endsWith("_stairs") && rightName?.endsWith("_stairs")) {
      shape = "straight";
    }

    return { ...state, properties: { ...properties, shape } };
  }

  if (state.name.endsWith("_fence") || state.name.endsWith("_wall") || state.name.endsWith("_pane") || state.name === "minecraft:iron_bars") {
    const directions = {
      north: [0, 0, -1] as Vec3,
      east: [1, 0, 0] as Vec3,
      south: [0, 0, 1] as Vec3,
      west: [-1, 0, 0] as Vec3,
    };
    const next: Record<string, string> = { ...properties };
    for (const [name, delta] of Object.entries(directions)) {
      const neighbor = states.get(key(add(pos, delta)));
      const connected = neighbor !== undefined && resolvesConnection(neighbor);
      next[name] = state.name.endsWith("_wall") ? (connected ? "low" : "none") : String(connected);
    }
    if (state.name.endsWith("_wall")) {
      const count = ["north", "east", "south", "west"].filter((name) => next[name] !== "none").length;
      next.up = String(count !== 2 || (next.north !== "none") === (next.east !== "none"));
    }
    return { ...state, properties: next };
  }

  return state;
}

export function validateCaptureDocument(value: unknown): asserts value is CaptureDocument {
  if (!value || typeof value !== "object") throw new TypeError("Capture document must be an object");
  const document = value as Partial<CaptureDocument>;
  if (document.format !== "cbe-r-capture" || document.version !== 1 || !Array.isArray(document.blocks)) {
    throw new TypeError("Unsupported capture document format");
  }
}

export function extractJavaStructure(
  document: CaptureDocument,
  cornerA: Vec3,
  cornerB: Vec3,
  options: ExtractOptions = {},
): JavaStructure {
  const [min, max] = normalizeBounds(cornerA, cornerB);
  const size: Vec3 = [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1];
  const selected: CaptureBlock[] = document.blocks.filter(({ pos }) =>
    pos[0] >= min[0] && pos[0] <= max[0] && pos[1] >= min[1] && pos[1] <= max[1] && pos[2] >= min[2] && pos[2] <= max[2],
  );

  const converted = new Map<string, JavaBlockState>();
  for (const entry of selected) converted.set(key(entry.pos), convertBedrockBlockState(entry.block, options));

  const blocks: StructureBlock[] = [];
  for (const entry of selected) {
    const initial = converted.get(key(entry.pos));
    if (!initial) continue;
    const state = resolveState(entry.pos, initial, converted);
    if (!options.includeAir && state.name === "minecraft:air") continue;
    const block: StructureBlock = entry.blockEntity
      ? { pos: offset(entry.pos, min), state, nbt: entry.blockEntity }
      : { pos: offset(entry.pos, min), state };
    blocks.push(block);
  }

  const entities = options.includeEntities
    ? (document.entities ?? [])
      .filter(({ pos }) => pos[0] >= min[0] && pos[0] <= max[0] && pos[1] >= min[1] && pos[1] <= max[1] && pos[2] >= min[2] && pos[2] <= max[2])
      .map((entity) => ({
        pos: [entity.pos[0] - min[0], entity.pos[1] - min[1], entity.pos[2] - min[2]] as const,
        blockPos: [Math.floor(entity.pos[0] - min[0]), Math.floor(entity.pos[1] - min[1]), Math.floor(entity.pos[2] - min[2])] as const,
        nbt: entity.nbt,
      }))
    : undefined;

  return entities
    ? { dataVersion: options.dataVersion ?? 3955, size, blocks, entities }
    : { dataVersion: options.dataVersion ?? 3955, size, blocks };
}
