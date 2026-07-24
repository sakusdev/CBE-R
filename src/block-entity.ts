/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NbtCompound, NbtValue, Vec3 } from "./types.js";

const ID_ALIASES: Readonly<Record<string, string>> = {
  chest: "minecraft:chest", trapped_chest: "minecraft:chest", barrel: "minecraft:barrel",
  furnace: "minecraft:furnace", blast_furnace: "minecraft:blast_furnace", smoker: "minecraft:smoker",
  hopper: "minecraft:hopper", dispenser: "minecraft:dispenser", dropper: "minecraft:dropper",
  brewing_stand: "minecraft:brewing_stand", enchanting_table: "minecraft:enchanting_table",
  beacon: "minecraft:beacon", ender_chest: "minecraft:ender_chest", shulker_box: "minecraft:shulker_box",
  sign: "minecraft:sign", hanging_sign: "minecraft:hanging_sign", skull: "minecraft:skull",
  mob_spawner: "minecraft:mob_spawner", spawner: "minecraft:mob_spawner",
  command_block: "minecraft:command_block", structure_block: "minecraft:structure_block",
  jigsaw_block: "minecraft:jigsaw", comparator: "minecraft:comparator", lectern: "minecraft:lectern",
  banner: "minecraft:banner", bed: "minecraft:bed", campfire: "minecraft:campfire",
  beehive: "minecraft:beehive", bell: "minecraft:bell", conduit: "minecraft:conduit",
  end_gateway: "minecraft:end_gateway", end_portal: "minecraft:end_portal", flower_pot: "minecraft:flower_pot",
  jukebox: "minecraft:jukebox", note_block: "minecraft:note_block", piston_arm: "minecraft:piston",
  moving_block: "minecraft:piston", brushable_block: "minecraft:brushable_block",
  decorated_pot: "minecraft:decorated_pot", chiseled_bookshelf: "minecraft:chiseled_bookshelf",
  crafter: "minecraft:crafter", trial_spawner: "minecraft:trial_spawner", vault: "minecraft:vault",
};

function isCompound(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function primitive(value: unknown): NbtValue | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => primitive(entry)).filter((entry): entry is NbtValue => entry !== undefined);
  if (isCompound(value)) return convertCompound(value);
  return undefined;
}

function convertCompound(value: Record<string, unknown>): NbtCompound {
  const output: Record<string, NbtValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    const converted = primitive(entry);
    if (converted !== undefined) output[key] = converted;
  }
  return output;
}

function namespaced(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const normalized = value.replace(/^tile\./u, "").replace(/^item\./u, "").toLowerCase();
  return normalized.includes(":") ? normalized : `minecraft:${normalized}`;
}

function jsonText(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify({ text: "" });
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object") return value;
  } catch { /* plain text */ }
  return JSON.stringify({ text: value });
}

function convertItem(value: unknown, slotFallback?: number): NbtCompound | undefined {
  if (!isCompound(value)) return undefined;
  const id = namespaced(value.Name ?? value.name ?? value.id);
  if (!id || id === "minecraft:air") return undefined;
  const countValue = value.Count ?? value.count ?? 1;
  const count = typeof countValue === "number" ? countValue : Number(countValue);
  const result: Record<string, NbtValue> = { id, count: Number.isFinite(count) ? count : 1 };
  const slot = value.Slot ?? value.slot ?? slotFallback;
  if (typeof slot === "number") result.Slot = slot;
  const damage = value.Damage ?? value.damage;
  const tagSource = value.tag ?? value.Tag;
  const components: Record<string, NbtValue> = {};
  if (typeof damage === "number" && damage !== 0) components["minecraft:damage"] = damage;
  if (isCompound(tagSource)) {
    const display = tagSource.display;
    if (isCompound(display) && typeof display.Name === "string") components["minecraft:custom_name"] = jsonText(display.Name);
    if (Array.isArray(display && isCompound(display) ? display.Lore : undefined)) {
      components["minecraft:lore"] = (display as Record<string, unknown>).Lore as unknown as NbtValue;
    }
    const ench = tagSource.ench ?? tagSource.Enchantments;
    if (Array.isArray(ench)) components["minecraft:enchantments"] = ench.map((entry) => convertCompound(isCompound(entry) ? entry : {}));
  }
  if (Object.keys(components).length > 0) result.components = components;
  return result;
}

function convertItems(value: unknown): readonly NbtValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((entry, index) => convertItem(entry, index)).filter((entry): entry is NbtCompound => entry !== undefined);
  return items.length > 0 ? items : undefined;
}

function sourceId(source: Record<string, unknown>): string {
  const raw = source.id ?? source.Id ?? source.identifier ?? source.type;
  const simple = typeof raw === "string" ? raw.replace(/^minecraft:/u, "").toLowerCase() : "";
  return ID_ALIASES[simple] ?? namespaced(raw) ?? "minecraft:unknown";
}

function copyKnown(source: Record<string, unknown>, target: Record<string, NbtValue>, keys: readonly string[]): void {
  for (const key of keys) {
    const value = primitive(source[key]);
    if (value !== undefined) target[key] = value;
  }
}

function convertSign(source: Record<string, unknown>, target: Record<string, NbtValue>): void {
  const messages = [1, 2, 3, 4].map((index) => jsonText(source[`Text${index}`] ?? ""));
  const color = typeof source.SignTextColor === "string" ? source.SignTextColor : "black";
  target.front_text = { messages, color, has_glowing_text: Boolean(source.IgnoreLighting) };
  const backText = source.BackText;
  if (isCompound(backText)) {
    target.back_text = {
      messages: [1, 2, 3, 4].map((index) => jsonText(backText[`Text${index}`] ?? "")),
      color: typeof backText.SignTextColor === "string" ? backText.SignTextColor : "black",
      has_glowing_text: Boolean(backText.IgnoreLighting),
    };
  } else target.back_text = { messages: [1, 2, 3, 4].map(() => jsonText("")), color: "black", has_glowing_text: false };
  if (source.IsWaxed === true || source.IsWaxed === 1) target.is_waxed = true;
}

function convertSpawner(source: Record<string, unknown>, target: Record<string, NbtValue>): void {
  const entityId = namespaced(source.EntityIdentifier ?? source.EntityId ?? source.entity_identifier);
  if (entityId) target.SpawnData = { entity: { id: entityId } };
  const mappings: ReadonlyArray<readonly [string, string]> = [
    ["Delay", "Delay"], ["MinSpawnDelay", "MinSpawnDelay"], ["MaxSpawnDelay", "MaxSpawnDelay"],
    ["SpawnCount", "SpawnCount"], ["MaxNearbyEntities", "MaxNearbyEntities"],
    ["RequiredPlayerRange", "RequiredPlayerRange"], ["SpawnRange", "SpawnRange"],
  ];
  for (const [from, to] of mappings) if (typeof source[from] === "number") target[to] = source[from] as number;
}

function convertSkull(source: Record<string, unknown>, target: Record<string, NbtValue>): void {
  const rotation = source.Rot ?? source.Rotation;
  if (typeof rotation === "number") target.Rot = rotation;
  const owner = source.SkullOwner ?? source.Owner;
  if (isCompound(owner)) target.profile = convertCompound(owner);
  else if (typeof owner === "string") target.profile = { name: owner };
  if (typeof source.MouthMoving === "boolean") target.note_block_sound = source.MouthMoving ? "minecraft:entity.ender_dragon.growl" : "";
}

function convertCommandBlock(source: Record<string, unknown>, target: Record<string, NbtValue>): void {
  const command = source.Command ?? source.command;
  if (typeof command === "string") target.Command = command;
  const name = source.CustomName ?? source.CustomNameVisible;
  if (typeof name === "string") target.CustomName = jsonText(name);
  target.auto = Boolean(source.auto ?? source.Auto);
  target.powered = Boolean(source.powered ?? source.Powered);
  target.conditionMet = Boolean(source.conditionMet ?? source.ConditionMet);
  if (typeof source.SuccessCount === "number") target.SuccessCount = source.SuccessCount;
  if (typeof source.LastOutput === "string") target.LastOutput = jsonText(source.LastOutput);
}

export interface ConvertBlockEntityOptions {
  readonly position?: Vec3;
  readonly blockName?: string;
}

/** Converts normalized Bedrock block-entity NBT into Java block-entity NBT. */
export function convertBedrockBlockEntity(source: NbtCompound, options: ConvertBlockEntityOptions = {}): NbtCompound {
  const raw = source as Record<string, unknown>;
  const id = sourceId(raw);
  const target: Record<string, NbtValue> = { id };
  if (options.position) {
    target.x = options.position[0]; target.y = options.position[1]; target.z = options.position[2];
  }
  const customName = raw.CustomName ?? raw.custom_name;
  if (typeof customName === "string" && customName.length > 0) target.CustomName = jsonText(customName);
  const lock = raw.Lock ?? raw.lock;
  if (typeof lock === "string" && lock.length > 0) target.Lock = lock;
  const items = convertItems(raw.Items ?? raw.items);
  if (items) target.Items = items;
  const lootTable = namespaced(raw.LootTable ?? raw.loot_table);
  if (lootTable) target.LootTable = lootTable;
  if (typeof raw.LootTableSeed === "number") target.LootTableSeed = raw.LootTableSeed;

  if (id.endsWith(":sign") || id.endsWith(":hanging_sign")) convertSign(raw, target);
  else if (id === "minecraft:mob_spawner" || id === "minecraft:trial_spawner") convertSpawner(raw, target);
  else if (id === "minecraft:skull") convertSkull(raw, target);
  else if (id === "minecraft:command_block") convertCommandBlock(raw, target);
  else if (id === "minecraft:jukebox") {
    const record = convertItem(raw.RecordItem ?? raw.record_item);
    if (record) target.RecordItem = record;
  } else if (id === "minecraft:lectern") {
    const book = convertItem(raw.book ?? raw.Book);
    if (book) target.Book = book;
    if (typeof raw.page === "number") target.Page = raw.page;
  } else if (id === "minecraft:flower_pot") {
    const item = namespaced(raw.PlantBlock?.toString() ?? raw.Item ?? raw.PlantBlock);
    if (item) target.item = item;
  } else if (id === "minecraft:decorated_pot") {
    const sherds = raw.sherds ?? raw.Sherds;
    if (Array.isArray(sherds)) target.sherds = sherds.map((entry) => namespaced(entry) ?? "minecraft:brick");
    const item = convertItem(raw.item ?? raw.Item);
    if (item) target.item = item;
  } else if (id === "minecraft:beacon") {
    copyKnown(raw, target, ["Levels", "Primary", "Secondary"]);
  } else if (id === "minecraft:banner") {
    target.Base = typeof raw.Base === "number" ? raw.Base : 0;
    const patterns = raw.Patterns ?? raw.patterns;
    if (Array.isArray(patterns)) target.patterns = patterns.map((entry) => convertCompound(isCompound(entry) ? entry : {}));
  } else if (id === "minecraft:brewing_stand") {
    copyKnown(raw, target, ["BrewTime", "Fuel"]);
  } else if (id === "minecraft:furnace" || id === "minecraft:blast_furnace" || id === "minecraft:smoker") {
    copyKnown(raw, target, ["BurnTime", "CookTime", "CookTimeTotal", "RecipesUsed"]);
  } else if (id === "minecraft:beehive") {
    const occupants = raw.Occupants ?? raw.Bees;
    if (Array.isArray(occupants)) target.Bees = occupants.map((entry) => convertCompound(isCompound(entry) ? entry : {}));
  } else if (id === "minecraft:campfire") {
    copyKnown(raw, target, ["CookingTimes", "CookingTotalTimes"]);
  } else if (id === "minecraft:end_gateway") {
    copyKnown(raw, target, ["Age", "ExactTeleport"]);
    if (Array.isArray(raw.ExitPortal)) target.ExitPortal = raw.ExitPortal as unknown as NbtValue;
  } else if (id === "minecraft:structure_block") {
    copyKnown(raw, target, ["name", "author", "metadata", "posX", "posY", "posZ", "sizeX", "sizeY", "sizeZ", "rotation", "mirror", "mode", "integrity", "seed", "ignoreEntities", "showboundingbox"]);
  } else if (id === "minecraft:jigsaw") {
    copyKnown(raw, target, ["name", "target", "pool", "final_state", "joint"]);
  } else if (id === "minecraft:chiseled_bookshelf") {
    if (typeof raw.last_interacted_slot === "number") target.last_interacted_slot = raw.last_interacted_slot;
  } else if (id === "minecraft:crafter") {
    if (typeof raw.crafting_ticks_remaining === "number") target.crafting_ticks_remaining = raw.crafting_ticks_remaining;
    if (typeof raw.triggered === "boolean") target.triggered = raw.triggered;
  }

  return target;
}
