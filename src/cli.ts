#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";
import { encodeJavaStructure, encodeJavaStructureGzip } from "./nbt.js";
import type { CaptureDocument, Vec3 } from "./types.js";
import { extractJavaStructure, validateCaptureDocument } from "./world.js";

interface Arguments {
  input: string;
  output: string;
  from: Vec3;
  to: Vec3;
  dataVersion: number;
  compressed: boolean;
  includeAir: boolean;
  includeEntities: boolean;
  unsupported: "barrier" | "air" | "throw";
}

function usage(): never {
  console.error(`Usage: cbe-r export --input capture.json --output building.nbt --from x,y,z --to x,y,z [options]\n\nOptions:\n  --data-version <number>       Java DataVersion (default: 3955)\n  --uncompressed                Write raw NBT instead of gzip NBT\n  --include-air                 Include captured air blocks\n  --include-entities            Include entities from the capture\n  --unsupported barrier|air|throw\n  --help                        Show this help`);
  process.exit(2);
}

function parseVec3(value: string | undefined, option: string): Vec3 {
  const values = value?.split(",").map(Number);
  if (!values || values.length !== 3 || values.some((entry) => !Number.isInteger(entry))) {
    throw new TypeError(`${option} must be three comma-separated integers`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

function parseArguments(argv: readonly string[]): Arguments {
  if (argv[0] !== "export" || argv.includes("--help")) usage();
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    if (["--uncompressed", "--include-air", "--include-entities"].includes(token)) {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }

  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) usage();
  const unsupported = values.get("--unsupported") ?? "barrier";
  if (unsupported !== "barrier" && unsupported !== "air" && unsupported !== "throw") {
    throw new TypeError("--unsupported must be barrier, air, or throw");
  }
  const dataVersion = Number(values.get("--data-version") ?? 3955);
  if (!Number.isInteger(dataVersion) || dataVersion <= 0) throw new TypeError("--data-version must be a positive integer");

  return {
    input,
    output,
    from: parseVec3(values.get("--from"), "--from"),
    to: parseVec3(values.get("--to"), "--to"),
    dataVersion,
    compressed: !flags.has("--uncompressed"),
    includeAir: flags.has("--include-air"),
    includeEntities: flags.has("--include-entities"),
    unsupported,
  };
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const parsed: unknown = JSON.parse(await readFile(args.input, "utf8"));
  validateCaptureDocument(parsed);
  const document: CaptureDocument = parsed;
  const structure = extractJavaStructure(document, args.from, args.to, {
    dataVersion: args.dataVersion,
    includeAir: args.includeAir,
    includeEntities: args.includeEntities,
    unsupportedBlockPolicy: args.unsupported,
  });
  const encoded = args.compressed ? encodeJavaStructureGzip(structure) : encodeJavaStructure(structure);
  await writeFile(args.output, encoded);
  const barriers = structure.blocks.filter(({ state }) => state.name === "minecraft:barrier").length;
  console.log(`${basename(args.output)}: ${structure.blocks.length} blocks, ${structure.entities?.length ?? 0} entities, ${encoded.length} bytes`);
  if (barriers > 0) console.warn(`Warning: ${barriers} unsupported block states were replaced with barriers`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
