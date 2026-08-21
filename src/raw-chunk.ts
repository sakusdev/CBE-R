/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import prismarineBlockLoader from "prismarine-block";
import prismarineRegistryFactory from "prismarine-registry";
import type { BedrockBlockState, BedrockStateValue } from "./bedrock.js";
import type { JournalDecoder, JournalPacketRecord } from "./journal.js";
import type { CaptureBlock, CaptureDocument } from "./types.js";

interface RegistryBlock {
  readonly stateId?: number;
}

interface RegistryBlockState {
  readonly name?: string;
  readonly states?: Readonly<Record<string, unknown>>;
}

interface RegistryLike {
  readonly blocksByRuntimeId?: Readonly<Record<string, RegistryBlock | undefined>> | readonly (RegistryBlock | undefined)[];
  readonly blockStates?: readonly (RegistryBlockState | undefined)[];
  supportFeature?: (feature: string) => boolean;
}

interface PrismarineBlockLike {
  readonly name: string;
  getProperties?: () => Readonly<Record<string, unknown>>;
  getProps?: () => Readonly<Record<string, unknown>>;
}

interface PrismarineBlockFactory {
  fromStateId(stateId: number): PrismarineBlockLike;
  getHash?: (name: string, states: Readonly<Record<string, unknown>>) => number | undefined;
}

type RegistryFactory = (version: string) => RegistryLike;
type BlockLoader = (registry: RegistryLike) => PrismarineBlockFactory;

const registryFactory = prismarineRegistryFactory as unknown as RegistryFactory;
const blockLoader = prismarineBlockLoader as unknown as BlockLoader;

export type RuntimeBlockResolver = (runtimeId: number) => BedrockBlockState;

class BufferReader {
  #offset = 0;

  constructor(readonly buffer: Buffer) {}

  get offset(): number { return this.#offset; }
  get remaining(): number { return this.buffer.length - this.#offset; }

  ensure(length: number): void {
    if (!Number.isInteger(length) || length < 0 || this.#offset + length > this.buffer.length) {
      throw new RangeError(`Unexpected end of subchunk payload at offset ${this.#offset}`);
    }
  }

  readUInt8(): number {
    this.ensure(1);
    return this.buffer[this.#offset++]!;
  }

  readInt8(): number {
    this.ensure(1);
    return this.buffer.readInt8(this.#offset++);
  }

  readUInt32LE(): number {
    this.ensure(4);
    const value = this.buffer.readUInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readUnsignedVarInt(): number {
    let value = 0;
    let shift = 0;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.readUInt8();
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value >>> 0;
      shift += 7;
    }
    throw new RangeError("Bedrock varint exceeds 5 bytes");
  }

  readZigZagVarInt(): number {
    const value = this.readUnsignedVarInt();
    return (value >>> 1) ^ -(value & 1);
  }
}

function normalizeProperties(value: Readonly<Record<string, unknown>>): Readonly<Record<string, BedrockStateValue>> | undefined {
  const entries: [string, BedrockStateValue][] = [];
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") entries.push([key, raw]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function registryCandidates(version: string): string[] {
  const normalized = version.startsWith("bedrock_") ? version.slice("bedrock_".length) : version;
  const candidates = [`bedrock_${normalized}`, normalized];
  if (/^26\./u.test(normalized)) {
    const legacyCalendarName = `1.${normalized}`;
    candidates.unshift(`bedrock_${legacyCalendarName}`, legacyCalendarName);
  }
  return [...new Set(candidates)];
}

function runtimeRegistryEntry(registry: RegistryLike, runtimeId: number): RegistryBlock | undefined {
  const table = registry.blocksByRuntimeId;
  if (!table) return undefined;
  return (table as Readonly<Record<string, RegistryBlock | undefined>>)[String(runtimeId)];
}

/** Resolves network runtime IDs, including signed FNV-1a block hashes on modern Bedrock versions. */
export function createRuntimeBlockResolver(protocolVersion: string): RuntimeBlockResolver {
  let registry: RegistryLike | undefined;
  let lastError: unknown;
  for (const candidate of registryCandidates(protocolVersion)) {
    try {
      registry = registryFactory(candidate);
      if (registry) break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!registry) {
    const message = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`No Prismarine Bedrock registry for protocol version ${protocolVersion}${message}`);
  }

  const Block = blockLoader(registry);
  const hashedRuntimeIds = registry.supportFeature?.("blockHashes") === true;
  const hashToStateId = new Map<number, number>();
  if (hashedRuntimeIds && Block.getHash) {
    for (const [stateId, state] of (registry.blockStates ?? []).entries()) {
      if (!state?.name) continue;
      const hash = Block.getHash(state.name, state.states ?? {});
      if (typeof hash === "number" && Number.isInteger(hash)) hashToStateId.set(hash | 0, stateId);
    }
  }

  return (runtimeId) => {
    if (!Number.isInteger(runtimeId) || runtimeId < -0x80000000 || runtimeId > 0x7fffffff) {
      throw new TypeError(`Invalid Bedrock runtime block ID: ${runtimeId}`);
    }
    const registryEntry = runtimeRegistryEntry(registry, runtimeId);
    const stateId = registryEntry?.stateId
      ?? (hashedRuntimeIds ? hashToStateId.get(runtimeId) : runtimeId);
    if (stateId === undefined) {
      throw new Error(`Unknown Bedrock runtime block ID ${runtimeId} for ${protocolVersion}`);
    }

    let block: PrismarineBlockLike;
    try {
      block = Block.fromStateId(stateId);
    } catch (error) {
      const message = error instanceof Error ? `: ${error.message}` : "";
      throw new Error(`Unknown Bedrock runtime block ID ${runtimeId} for ${protocolVersion}${message}`);
    }
    if (!block.name) throw new Error(`Unknown Bedrock runtime block ID ${runtimeId} for ${protocolVersion}`);
    const rawProperties = block.getProperties?.() ?? block.getProps?.() ?? {};
    const states = normalizeProperties(rawProperties);
    const name = block.name.includes(":") ? block.name : `minecraft:${block.name}`;
    return { name, ...(states ? { states } : {}) };
  };
}

interface DecodedStorage {
  readonly palette: readonly BedrockBlockState[];
  readonly indexes: Uint16Array;
}

function decodeStorage(reader: BufferReader, resolveRuntimeId: RuntimeBlockResolver): DecodedStorage {
  const paletteType = reader.readUInt8();
  if ((paletteType & 1) === 0) throw new Error("Persistent Bedrock subchunk palettes are not valid in live runtime packets");
  const bitsPerBlock = paletteType >>> 1;
  if (bitsPerBlock === 0) {
    const runtimeId = reader.readZigZagVarInt();
    return { palette: [resolveRuntimeId(runtimeId)], indexes: new Uint16Array(4096) };
  }
  if (![1, 2, 3, 4, 5, 6, 8, 16].includes(bitsPerBlock)) throw new Error(`Unsupported Bedrock bits-per-block value: ${bitsPerBlock}`);

  const blocksPerWord = Math.floor(32 / bitsPerBlock);
  const wordCount = Math.ceil(4096 / blocksPerWord);
  const words = new Uint32Array(wordCount);
  for (let index = 0; index < wordCount; index += 1) words[index] = reader.readUInt32LE();

  const paletteSize = reader.readZigZagVarInt();
  if (paletteSize < 1 || paletteSize > 65536) throw new Error(`Invalid Bedrock runtime palette size: ${paletteSize}`);
  const palette: BedrockBlockState[] = [];
  for (let index = 0; index < paletteSize; index += 1) palette.push(resolveRuntimeId(reader.readZigZagVarInt()));

  const mask = bitsPerBlock === 16 ? 0xffff : (1 << bitsPerBlock) - 1;
  const indexes = new Uint16Array(4096);
  for (let linear = 0; linear < 4096; linear += 1) {
    const wordIndex = Math.floor(linear / blocksPerWord);
    const bitOffset = (linear % blocksPerWord) * bitsPerBlock;
    const paletteIndex = (words[wordIndex]! >>> bitOffset) & mask;
    if (paletteIndex >= palette.length) throw new Error(`Subchunk palette index ${paletteIndex} exceeds palette size ${palette.length}`);
    indexes[linear] = paletteIndex;
  }
  return { palette, indexes };
}

export interface DecodedRuntimeSubChunk {
  readonly sectionY: number;
  readonly blocks: readonly CaptureBlock[];
  readonly bytesRead: number;
}

function isAir(block: BedrockBlockState): boolean {
  return block.name === "minecraft:air" || block.name === "air";
}

function isWater(block: BedrockBlockState): boolean {
  return block.name === "minecraft:water" || block.name === "minecraft:flowing_water" || block.name === "water" || block.name === "flowing_water";
}

/** Decodes one network-runtime Bedrock subchunk (versions 1, 8, and 9). */
export function decodeRuntimeSubChunk(
  payload: Buffer,
  chunkX: number,
  chunkZ: number,
  fallbackSectionY: number,
  resolveRuntimeId: RuntimeBlockResolver,
): DecodedRuntimeSubChunk {
  const reader = new BufferReader(payload);
  const version = reader.readUInt8();
  let storageCount = 1;
  let sectionY = fallbackSectionY;
  if (version === 8 || version === 9) {
    storageCount = reader.readUInt8();
    if (version === 9) sectionY = reader.readInt8();
  } else if (version !== 1) {
    throw new Error(`Unsupported Bedrock subchunk version: ${version}`);
  }
  if (storageCount < 1 || storageCount > 16) throw new Error(`Invalid Bedrock subchunk storage count: ${storageCount}`);

  const storages: DecodedStorage[] = [];
  for (let layer = 0; layer < storageCount; layer += 1) storages.push(decodeStorage(reader, resolveRuntimeId));

  const blocks: CaptureBlock[] = [];
  const primary = storages[0]!;
  const secondary = storages[1];
  for (let x = 0; x < 16; x += 1) {
    for (let z = 0; z < 16; z += 1) {
      for (let y = 0; y < 16; y += 1) {
        const linear = (x << 8) | (z << 4) | y;
        const base = primary.palette[primary.indexes[linear]!]!;
        let block = base;
        if (secondary) {
          const overlay = secondary.palette[secondary.indexes[linear]!]!;
          if (isWater(overlay)) {
            block = isAir(base)
              ? overlay
              : { ...base, states: { ...(base.states ?? {}), waterlogged_bit: true } };
          } else if (isAir(base) && !isAir(overlay)) {
            block = overlay;
          }
        }
        blocks.push({
          pos: [chunkX * 16 + x, sectionY * 16 + y, chunkZ * 16 + z],
          block,
        });
      }
    }
  }
  return { sectionY, blocks, bytesRead: reader.offset };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function dimensionName(value: unknown): string | undefined {
  if (value === 0 || value === "overworld") return "minecraft:overworld";
  if (value === 1 || value === "nether") return "minecraft:the_nether";
  if (value === 2 || value === "end") return "minecraft:the_end";
  return undefined;
}

function packetParams(record: JournalPacketRecord): Record<string, unknown> | undefined {
  return isRecord(record.params) ? record.params : isRecord(record.data) ? record.data : undefined;
}

function hasNormalizedPayload(params: Record<string, unknown>): boolean {
  return Array.isArray(params.blocks) || Array.isArray(params.entities);
}

const resolverCache = new Map<string, RuntimeBlockResolver>();

function resolverFor(version: string): RuntimeBlockResolver {
  let resolver = resolverCache.get(version);
  if (!resolver) {
    resolver = createRuntimeBlockResolver(version);
    resolverCache.set(version, resolver);
  }
  return resolver;
}

function decodeLevelChunk(record: JournalPacketRecord, version: string): Partial<CaptureDocument> | undefined {
  const params = packetParams(record);
  if (!params || hasNormalizedPayload(params) || !Buffer.isBuffer(params.payload)) return undefined;
  if (params.cache_enabled === true) throw new Error("Cached level_chunk payloads are unsupported; capture with client chunk caching disabled");
  const chunkX = integer(params.x);
  const chunkZ = integer(params.z);
  const count = integer(params.sub_chunk_count);
  if (chunkX === undefined || chunkZ === undefined || count === undefined || count <= 0) return undefined;

  const payload = params.payload;
  const resolveRuntimeId = resolverFor(version);
  const blocks: CaptureBlock[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const decoded = decodeRuntimeSubChunk(payload.subarray(offset), chunkX, chunkZ, index, resolveRuntimeId);
    blocks.push(...decoded.blocks);
    offset += decoded.bytesRead;
  }
  return {
    format: "cbe-r-capture",
    version: 1,
    ...(dimensionName(params.dimension) ? { dimension: dimensionName(params.dimension)! } : {}),
    blocks,
  };
}

function decodeSubChunkPacket(record: JournalPacketRecord, version: string): Partial<CaptureDocument> | undefined {
  const params = packetParams(record);
  if (!params || hasNormalizedPayload(params) || !Array.isArray(params.entries) || !isRecord(params.origin)) return undefined;
  if (params.cache_enabled === true) throw new Error("Cached subchunk payloads are unsupported; capture with client chunk caching disabled");
  const originX = integer(params.origin.x);
  const originY = integer(params.origin.y);
  const originZ = integer(params.origin.z);
  if (originX === undefined || originY === undefined || originZ === undefined) return undefined;

  const resolveRuntimeId = resolverFor(version);
  const blocks: CaptureBlock[] = [];
  for (const entry of params.entries) {
    if (!isRecord(entry) || entry.result === "success_all_air" || entry.result === 6) continue;
    if (entry.result !== "success" && entry.result !== 1) continue;
    if (!Buffer.isBuffer(entry.payload)) continue;
    const dx = integer(entry.dx) ?? 0;
    const dy = integer(entry.dy) ?? 0;
    const dz = integer(entry.dz) ?? 0;
    const chunkX = originX + dx;
    const sectionY = originY + dy;
    const chunkZ = originZ + dz;
    blocks.push(...decodeRuntimeSubChunk(entry.payload, chunkX, chunkZ, sectionY, resolveRuntimeId).blocks);
  }
  if (blocks.length === 0) return undefined;
  return {
    format: "cbe-r-capture",
    version: 1,
    ...(dimensionName(params.dimension) ? { dimension: dimensionName(params.dimension)! } : {}),
    blocks,
  };
}

export const rawBedrockChunkDecoder: JournalDecoder = {
  id: "bedrock-runtime-subchunk-v1",
  versions: "*",
  decode(record, context) {
    const version = context.protocolVersion;
    if (!version) return undefined;
    if (record.name === "level_chunk") return decodeLevelChunk(record, version);
    if (record.name === "subchunk" || record.name === "sub_chunk") return decodeSubChunkPacket(record, version);
    return undefined;
  },
};
