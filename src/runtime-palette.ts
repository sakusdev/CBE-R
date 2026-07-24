/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { BedrockBlockState, BedrockStateValue } from "./bedrock.js";
import type { JournalPacketRecord } from "./journal.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): BedrockStateValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["value", "data", "val"]) {
    const unwrapped = scalar(value[key]);
    if (unwrapped !== undefined) return unwrapped;
  }
  return undefined;
}

function normalizeStates(value: unknown): Readonly<Record<string, BedrockStateValue>> | undefined {
  if (Array.isArray(value)) {
    const entries: [string, BedrockStateValue][] = [];
    for (const item of value) {
      if (!isRecord(item)) continue;
      const name = typeof item.name === "string" ? item.name : typeof item.key === "string" ? item.key : undefined;
      const state = scalar(item.value ?? item.data ?? item.val);
      if (name && state !== undefined) entries.push([name, state]);
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries: [string, BedrockStateValue][] = [];
  for (const [name, raw] of Object.entries(value)) {
    const state = scalar(raw);
    if (state !== undefined) entries.push([name, state]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeBlock(value: unknown): BedrockBlockState | undefined {
  if (!isRecord(value)) return undefined;
  const name = typeof value.name === "string"
    ? value.name
    : typeof value.identifier === "string"
      ? value.identifier
      : typeof value.block_name === "string"
        ? value.block_name
        : undefined;
  if (!name) return undefined;
  const states = normalizeStates(value.states ?? value.state ?? value.properties);
  return { name, ...(states ? { states } : {}) };
}

function paletteEntries(record: JournalPacketRecord): readonly unknown[] {
  const root = isRecord(record.params) ? record.params : isRecord(record.data) ? record.data : undefined;
  if (!root) return [];
  for (const key of ["block_properties", "blockProperties", "block_palette", "blockPalette", "blocks"]) {
    if (Array.isArray(root[key])) return root[key];
  }
  return [];
}

export class RuntimeBlockRegistry {
  readonly #blocks = new Map<number, BedrockBlockState>();

  get size(): number { return this.#blocks.size; }

  set(runtimeId: number, block: BedrockBlockState): void {
    if (!Number.isInteger(runtimeId) || runtimeId < 0) throw new TypeError("Runtime ID must be a non-negative integer");
    this.#blocks.set(runtimeId, block);
  }

  get(runtimeId: number): BedrockBlockState | undefined { return this.#blocks.get(runtimeId); }

  require(runtimeId: number): BedrockBlockState {
    const block = this.get(runtimeId);
    if (!block) throw new Error(`Unknown Bedrock runtime block ID: ${runtimeId}`);
    return block;
  }

  entries(): readonly (readonly [number, BedrockBlockState])[] {
    return [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]);
  }

  ingestStartGame(record: JournalPacketRecord): number {
    if (record.name !== "start_game") return 0;
    let added = 0;
    for (const [index, raw] of paletteEntries(record).entries()) {
      const block = normalizeBlock(raw);
      if (!block) continue;
      const item = isRecord(raw) ? raw : {};
      const explicit = item.runtime_id ?? item.runtimeId ?? item.network_id ?? item.networkId ?? item.id;
      const runtimeId = typeof explicit === "number" && Number.isInteger(explicit) ? explicit : index;
      this.set(runtimeId, block);
      added += 1;
    }
    return added;
  }

  static fromJournal(records: readonly JournalPacketRecord[]): RuntimeBlockRegistry {
    const registry = new RuntimeBlockRegistry();
    for (const record of records) registry.ingestStartGame(record);
    return registry;
  }
}
