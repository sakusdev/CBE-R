/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type Vec3 = readonly [x: number, y: number, z: number];

export interface JavaBlockState {
  readonly name: `minecraft:${string}`;
  readonly properties?: Readonly<Record<string, string>>;
}

export interface StructureBlock {
  readonly pos: Vec3;
  readonly state: JavaBlockState;
}

export interface JavaStructure {
  readonly dataVersion: number;
  readonly size: Vec3;
  readonly blocks: readonly StructureBlock[];
}
