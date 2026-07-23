/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { gzipSync } from "node:zlib";
import type { JavaBlockState, JavaStructure, NbtCompound, NbtValue } from "./types.js";

const TAG_END = 0;
const TAG_BYTE = 1;
const TAG_INT = 3;
const TAG_DOUBLE = 6;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;

class Writer {
  readonly chunks: Buffer[] = [];
  byte(value: number): void { const b = Buffer.allocUnsafe(1); b.writeInt8(value); this.chunks.push(b); }
  unsignedByte(value: number): void { const b = Buffer.allocUnsafe(1); b.writeUInt8(value); this.chunks.push(b); }
  int(value: number): void { const b = Buffer.allocUnsafe(4); b.writeInt32BE(value); this.chunks.push(b); }
  double(value: number): void { const b = Buffer.allocUnsafe(8); b.writeDoubleBE(value); this.chunks.push(b); }
  string(value: string): void {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.length > 0xffff) throw new RangeError("NBT string exceeds 65535 bytes");
    const length = Buffer.allocUnsafe(2); length.writeUInt16BE(encoded.length); this.chunks.push(length, encoded);
  }
  named(type: number, name: string, payload: () => void): void { this.unsignedByte(type); this.string(name); payload(); }
  finish(): Buffer { return Buffer.concat(this.chunks); }
}

function stateKey(state: JavaBlockState): string {
  return JSON.stringify([state.name, Object.entries(state.properties ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
}

function writeStateCompound(writer: Writer, state: JavaBlockState): void {
  writer.named(TAG_STRING, "Name", () => writer.string(state.name));
  const properties = Object.entries(state.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (properties.length > 0) {
    writer.named(TAG_COMPOUND, "Properties", () => {
      for (const [name, value] of properties) writer.named(TAG_STRING, name, () => writer.string(value));
      writer.unsignedByte(TAG_END);
    });
  }
  writer.unsignedByte(TAG_END);
}

function tagOf(value: NbtValue): number {
  if (typeof value === "boolean") return TAG_BYTE;
  if (typeof value === "number") return Number.isInteger(value) ? TAG_INT : TAG_DOUBLE;
  if (typeof value === "string") return TAG_STRING;
  if (Array.isArray(value)) return TAG_LIST;
  return TAG_COMPOUND;
}

function writePayload(writer: Writer, type: number, value: NbtValue): void {
  switch (type) {
    case TAG_BYTE: writer.byte(value ? 1 : 0); return;
    case TAG_INT: writer.int(value as number); return;
    case TAG_DOUBLE: writer.double(value as number); return;
    case TAG_STRING: writer.string(value as string); return;
    case TAG_COMPOUND: writeCompoundPayload(writer, value as NbtCompound); return;
    case TAG_LIST: {
      const values = value as readonly NbtValue[];
      const elementType = values.length === 0 ? TAG_END : tagOf(values[0]!);
      if (values.some((entry) => tagOf(entry) !== elementType)) throw new TypeError("NBT lists must contain one tag type");
      writer.unsignedByte(elementType); writer.int(values.length);
      for (const entry of values) writePayload(writer, elementType, entry);
      return;
    }
    default: throw new TypeError(`Unsupported NBT tag type: ${type}`);
  }
}

function writeCompoundPayload(writer: Writer, compound: NbtCompound): void {
  for (const [name, value] of Object.entries(compound)) {
    const type = tagOf(value);
    writer.named(type, name, () => writePayload(writer, type, value));
  }
  writer.unsignedByte(TAG_END);
}

export function encodeJavaStructure(structure: JavaStructure): Buffer {
  const [width, height, depth] = structure.size;
  if (width <= 0 || height <= 0 || depth <= 0) throw new RangeError("Structure size values must be positive");

  const palette: JavaBlockState[] = [];
  const paletteIndex = new Map<string, number>();
  const indexedBlocks = structure.blocks.map((block) => {
    const [x, y, z] = block.pos;
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) {
      throw new RangeError(`Block position ${block.pos.join(",")} is outside the structure`);
    }
    const key = stateKey(block.state);
    let index = paletteIndex.get(key);
    if (index === undefined) { index = palette.length; paletteIndex.set(key, index); palette.push(block.state); }
    return { block, index };
  });

  const writer = new Writer();
  writer.unsignedByte(TAG_COMPOUND); writer.string("");
  writer.named(TAG_INT, "DataVersion", () => writer.int(structure.dataVersion));
  writer.named(TAG_LIST, "size", () => { writer.unsignedByte(TAG_INT); writer.int(3); writer.int(width); writer.int(height); writer.int(depth); });
  writer.named(TAG_LIST, "palette", () => { writer.unsignedByte(TAG_COMPOUND); writer.int(palette.length); for (const state of palette) writeStateCompound(writer, state); });
  writer.named(TAG_LIST, "blocks", () => {
    writer.unsignedByte(TAG_COMPOUND); writer.int(indexedBlocks.length);
    for (const { block, index } of indexedBlocks) {
      writer.named(TAG_LIST, "pos", () => { writer.unsignedByte(TAG_INT); writer.int(3); for (const coordinate of block.pos) writer.int(coordinate); });
      writer.named(TAG_INT, "state", () => writer.int(index));
      if (block.nbt) writer.named(TAG_COMPOUND, "nbt", () => writeCompoundPayload(writer, block.nbt!));
      writer.unsignedByte(TAG_END);
    }
  });
  writer.named(TAG_LIST, "entities", () => {
    const entities = structure.entities ?? [];
    writer.unsignedByte(TAG_COMPOUND); writer.int(entities.length);
    for (const entity of entities) {
      writer.named(TAG_LIST, "pos", () => { writer.unsignedByte(TAG_DOUBLE); writer.int(3); for (const coordinate of entity.pos) writer.double(coordinate); });
      writer.named(TAG_LIST, "blockPos", () => { writer.unsignedByte(TAG_INT); writer.int(3); for (const coordinate of entity.blockPos) writer.int(coordinate); });
      writer.named(TAG_COMPOUND, "nbt", () => writeCompoundPayload(writer, entity.nbt));
      writer.unsignedByte(TAG_END);
    }
  });
  writer.unsignedByte(TAG_END);
  return writer.finish();
}

export function encodeJavaStructureGzip(structure: JavaStructure): Buffer {
  return gzipSync(encodeJavaStructure(structure));
}
