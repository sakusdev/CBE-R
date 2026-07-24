/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { convertBedrockBlockEntity, extractJavaStructure } from "../src/index.js";
import type { CaptureDocument, NbtCompound } from "../src/types.js";

test("converts container inventory and coordinates", () => {
  const converted = convertBedrockBlockEntity({
    id: "Chest",
    CustomName: "Storage",
    Items: [{ Slot: 2, Name: "minecraft:diamond", Count: 3 }],
  }, { position: [1, 2, 3] });
  assert.equal(converted.id, "minecraft:chest");
  assert.equal(converted.x, 1);
  assert.equal(converted.y, 2);
  assert.equal(converted.z, 3);
  assert.equal(converted.CustomName, JSON.stringify({ text: "Storage" }));
  const items = converted.Items as readonly NbtCompound[];
  assert.equal(items[0]?.id, "minecraft:diamond");
  assert.equal(items[0]?.count, 3);
  assert.equal(items[0]?.Slot, 2);
});

test("converts sign text to modern front and back text", () => {
  const converted = convertBedrockBlockEntity({
    id: "Sign",
    Text1: "one",
    Text2: "two",
    SignTextColor: "blue",
    IgnoreLighting: true,
    IsWaxed: true,
  });
  const front = converted.front_text as NbtCompound;
  assert.deepEqual(front.messages, [
    JSON.stringify({ text: "one" }), JSON.stringify({ text: "two" }),
    JSON.stringify({ text: "" }), JSON.stringify({ text: "" }),
  ]);
  assert.equal(front.color, "blue");
  assert.equal(front.has_glowing_text, true);
  assert.equal(converted.is_waxed, true);
});

test("converts spawner, command block, jukebox, and lectern fields", () => {
  const spawner = convertBedrockBlockEntity({ id: "MobSpawner", EntityIdentifier: "zombie", Delay: 20 });
  assert.equal(spawner.id, "minecraft:mob_spawner");
  assert.deepEqual(spawner.SpawnData, { entity: { id: "minecraft:zombie" } });
  assert.equal(spawner.Delay, 20);

  const command = convertBedrockBlockEntity({ id: "CommandBlock", Command: "say hi", CustomName: "Runner", auto: true });
  assert.equal(command.Command, "say hi");
  assert.equal(command.auto, true);

  const jukebox = convertBedrockBlockEntity({ id: "Jukebox", RecordItem: { Name: "music_disc_13", Count: 1 } });
  assert.equal((jukebox.RecordItem as NbtCompound).id, "minecraft:music_disc_13");

  const lectern = convertBedrockBlockEntity({ id: "Lectern", page: 4, book: { Name: "written_book", Count: 1 } });
  assert.equal(lectern.Page, 4);
  assert.equal((lectern.Book as NbtCompound).id, "minecraft:written_book");
});

test("structure extraction applies block entity conversion", () => {
  const document: CaptureDocument = {
    format: "cbe-r-capture",
    version: 1,
    blocks: [{
      pos: [10, 64, 10],
      block: { name: "minecraft:chest" },
      blockEntity: { id: "Chest", Items: [{ Slot: 0, Name: "apple", Count: 2 }] },
    }],
  };
  const structure = extractJavaStructure(document, [10, 64, 10], [10, 64, 10]);
  assert.equal(structure.blocks[0]?.nbt?.id, "minecraft:chest");
  assert.equal(structure.blocks[0]?.nbt?.x, 0);
  assert.equal(((structure.blocks[0]?.nbt?.Items as readonly NbtCompound[])[0]?.id), "minecraft:apple");
});
