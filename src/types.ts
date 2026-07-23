/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export type Vec3 = readonly [x: number, y: number, z: number];

export interface JavaBlockState {
  readonly name: `minecraft:${string}`;
  readonly properties?: Readonly<Record<string, string>>;
}

export type NbtScalar = string | number | boolean;
export interface NbtList extends ReadonlyArray<NbtValue> {}
export interface NbtCompound { readonly [key: string]: NbtValue; }
export type NbtValue = NbtScalar | NbtList | NbtCompound;

export interface StructureBlock {
  readonly pos: Vec3;
  readonly state: JavaBlockState;
  readonly nbt?: NbtCompound;
}

export interface StructureEntity {
  readonly pos: readonly [x: number, y: number, z: number];
  readonly blockPos: Vec3;
  readonly nbt: NbtCompound;
}

export interface JavaStructure {
  readonly dataVersion: number;
  readonly size: Vec3;
  readonly blocks: readonly StructureBlock[];
  readonly entities?: readonly StructureEntity[];
}

export interface CaptureBlock {
  readonly pos: Vec3;
  readonly block: {
    readonly name: string;
    readonly states?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly blockEntity?: NbtCompound;
}

export interface CaptureEntity {
  readonly pos: readonly [x: number, y: number, z: number];
  readonly nbt: NbtCompound;
}

export interface CaptureDocument {
  readonly format: "cbe-r-capture";
  readonly version: 1;
  readonly dimension?: string;
  readonly blocks: readonly CaptureBlock[];
  readonly entities?: readonly CaptureEntity[];
}
