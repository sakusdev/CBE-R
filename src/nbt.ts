/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { gzipSync } from "node:zlib";
import type { JavaBlockState, JavaStructure } from "./types.js";

const TAG_END = 0;
const TAG_INT = 3;
const TAG_STRING = 8;
const TAG_LIST = 9;
const TAG_COMPOUND = 10;

class Writer {
  readonly chunks: Buffer[] = [];

  byte(value: number): void {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value);
    this.chunks.push(buffer);
  }

  int(value: number): void {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value);
    this.chunks.push(buffer);
  }

  string(value: string): void {
    const encoded = Buffer.from(value, "utf8");
    if (encoded.length > 0xffff) throw new RangeError("NBT string exceeds 65535 bytes");
    const length = Buffer.allocUnsafe(2);
    length.writeUInt16BE(encoded.length);
    this.chunks.push(length, encoded);
  }

  named(type: number, name: string, payload: () => void): void {
    this.byte(type);
    this.string(name);
    payload();
  }

  finish(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

function stateKey(state: JavaBlockState): string {
  const entries = Object.entries(state.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([state.name, entries]);
}

function writeStateCompound(writer: Writer, state: JavaBlockState): void {
  writer.named(TAG_STRING, "Name", () => writer.string(state.name));
  const properties = Object.entries(state.properties ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (properties.length > 0) {
    writer.named(TAG_COMPOUND, "Properties", () => {
      for (const [name, value] of properties) {
        writer.named(TAG_STRING, name, () => writer.string(value));
      }
      writer.byte(TAG_END);
    });
  }
  writer.byte(TAG_END);
}

export function encodeJavaStructure(structure: JavaStructure): Buffer {
  const [width, height, depth] = structure.size;
  if (width <= 0 || height <= 0 || depth <= 0) {
    throw new RangeError("Structure size values must be positive");
  }

  const palette: JavaBlockState[] = [];
  const paletteIndex = new Map<string, number>();
  const indexedBlocks = structure.blocks.map((block) => {
    const [x, y, z] = block.pos;
    if (x < 0 || y < 0 || z < 0 || x >= width || y >= height || z >= depth) {
      throw new RangeError(`Block position ${block.pos.join(",")} is outside the structure`);
    }
    const key = stateKey(block.state);
    let index = paletteIndex.get(key);
    if (index === undefined) {
      index = palette.length;
      paletteIndex.set(key, index);
      palette.push(block.state);
    }
    return { block, index };
  });

  const writer = new Writer();
  writer.byte(TAG_COMPOUND);
  writer.string("");

  writer.named(TAG_INT, "DataVersion", () => writer.int(structure.dataVersion));
  writer.named(TAG_LIST, "size", () => {
    writer.byte(TAG_INT);
    writer.int(3);
    writer.int(width);
    writer.int(height);
    writer.int(depth);
  });

  writer.named(TAG_LIST, "palette", () => {
    writer.byte(TAG_COMPOUND);
    writer.int(palette.length);
    for (const state of palette) writeStateCompound(writer, state);
  });

  writer.named(TAG_LIST, "blocks", () => {
    writer.byte(TAG_COMPOUND);
    writer.int(indexedBlocks.length);
    for (const { block, index } of indexedBlocks) {
      writer.named(TAG_LIST, "pos", () => {
        writer.byte(TAG_INT);
        writer.int(3);
        for (const coordinate of block.pos) writer.int(coordinate);
      });
      writer.named(TAG_INT, "state", () => writer.int(index));
      writer.byte(TAG_END);
    }
  });

  writer.named(TAG_LIST, "entities", () => {
    writer.byte(TAG_COMPOUND);
    writer.int(0);
  });

  writer.byte(TAG_END);
  return writer.finish();
}

export function encodeJavaStructureGzip(structure: JavaStructure): Buffer {
  return gzipSync(encodeJavaStructure(structure));
}
