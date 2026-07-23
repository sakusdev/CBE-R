/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CaptureDocument, Vec3 } from "./types.js";

export interface StructureRegion {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly index: readonly [x: number, y: number, z: number];
}

export function captureBounds(document: CaptureDocument): readonly [min: Vec3, max: Vec3] {
  if (document.blocks.length === 0) throw new Error("Capture contains no blocks");
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const { pos: [x, y, z] } of document.blocks) {
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return [[minX, minY, minZ], [maxX, maxY, maxZ]];
}

export function splitBounds(from: Vec3, to: Vec3, maxSize: number | Vec3): StructureRegion[] {
  const [sx, sy, sz] = typeof maxSize === "number" ? [maxSize, maxSize, maxSize] : maxSize;
  if (![sx, sy, sz].every((value) => Number.isInteger(value) && value > 0)) {
    throw new TypeError("Split sizes must be positive integers");
  }
  const min: Vec3 = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])];
  const max: Vec3 = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])];
  const regions: StructureRegion[] = [];
  let ix = 0;
  for (let x = min[0]; x <= max[0]; x += sx, ix += 1) {
    let iy = 0;
    for (let y = min[1]; y <= max[1]; y += sy, iy += 1) {
      let iz = 0;
      for (let z = min[2]; z <= max[2]; z += sz, iz += 1) {
        regions.push({
          from: [x, y, z],
          to: [Math.min(x + sx - 1, max[0]), Math.min(y + sy - 1, max[1]), Math.min(z + sz - 1, max[2])],
          index: [ix, iy, iz],
        });
      }
    }
  }
  return regions;
}

export function regionFilename(output: string, index: readonly [number, number, number]): string {
  const dot = output.toLowerCase().endsWith(".nbt") ? output.length - 4 : output.length;
  return `${output.slice(0, dot)}_${index[0]}_${index[1]}_${index[2]}.nbt`;
}
