#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";
import { captureBedrockSession } from "./live.js";
import type { LiveCaptureOptions } from "./live.js";
import { encodeJavaStructure, encodeJavaStructureGzip } from "./nbt.js";
import type { CaptureDocument, Vec3 } from "./types.js";
import { extractJavaStructure, validateCaptureDocument } from "./world.js";

function usage(exitCode = 2): never {
  console.error(`CBE-R

Commands:
  cbe-r export --input capture.json --output building.nbt --from x,y,z --to x,y,z [options]
  cbe-r capture --host example.org --username ProfileName --output session.ndjson [options]

Export options:
  --data-version <number>       Java DataVersion (default: 3955)
  --uncompressed                Write raw NBT instead of gzip NBT
  --include-air                 Include captured air blocks
  --include-entities            Include entities from the capture
  --unsupported barrier|air|throw

Capture options:
  --port <number>               Bedrock UDP port (default: 19132)
  --version <version>           Pin a Bedrock protocol version; default is auto
  --offline                     Disable Microsoft/Xbox authentication
  --profiles-folder <path>      Authentication token cache directory
  --duration <seconds>          Stop automatically after N seconds
  --connect-timeout <seconds>   Connection timeout (default: 15)
  --raknet jsp-raknet|raknet-node|raknet-native

  --help                        Show this help`);
  process.exit(exitCode);
}

function parseTokens(argv: readonly string[], booleanFlags: readonly string[]): {
  readonly values: Map<string, string>;
  readonly flags: Set<string>;
} {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) throw new TypeError(`Unexpected argument: ${token}`);
    if (booleanFlags.includes(token)) {
      flags.add(token);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`Missing value for ${token}`);
    values.set(token, value);
    index += 1;
  }
  return { values, flags };
}

function parseVec3(value: string | undefined, option: string): Vec3 {
  const values = value?.split(",").map(Number);
  if (!values || values.length !== 3 || values.some((entry) => !Number.isInteger(entry))) {
    throw new TypeError(`${option} must be three comma-separated integers`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

function positiveInteger(value: string | undefined, option: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return parsed;
}

async function exportCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--uncompressed", "--include-air", "--include-entities"]);
  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) usage();
  const unsupported = values.get("--unsupported") ?? "barrier";
  if (unsupported !== "barrier" && unsupported !== "air" && unsupported !== "throw") {
    throw new TypeError("--unsupported must be barrier, air, or throw");
  }

  const parsed: unknown = JSON.parse(await readFile(input, "utf8"));
  validateCaptureDocument(parsed);
  const document: CaptureDocument = parsed;
  const structure = extractJavaStructure(document, parseVec3(values.get("--from"), "--from"), parseVec3(values.get("--to"), "--to"), {
    dataVersion: positiveInteger(values.get("--data-version"), "--data-version", 3955),
    includeAir: flags.has("--include-air"),
    includeEntities: flags.has("--include-entities"),
    unsupportedBlockPolicy: unsupported,
  });
  const encoded = flags.has("--uncompressed") ? encodeJavaStructure(structure) : encodeJavaStructureGzip(structure);
  await writeFile(output, encoded);
  const barriers = structure.blocks.filter(({ state }) => state.name === "minecraft:barrier").length;
  console.log(`${basename(output)}: ${structure.blocks.length} blocks, ${structure.entities?.length ?? 0} entities, ${encoded.length} bytes`);
  if (barriers > 0) console.warn(`Warning: ${barriers} unsupported block states were replaced with barriers`);
}

async function captureCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--offline"]);
  const host = values.get("--host");
  const username = values.get("--username");
  const output = values.get("--output");
  if (!host || !username || !output) usage();
  const raknet = values.get("--raknet") ?? "jsp-raknet";
  if (raknet !== "jsp-raknet" && raknet !== "raknet-node" && raknet !== "raknet-native") {
    throw new TypeError("--raknet must be jsp-raknet, raknet-node, or raknet-native");
  }
  const options: LiveCaptureOptions = {
    host,
    username,
    output,
    port: positiveInteger(values.get("--port"), "--port", 19132),
    offline: flags.has("--offline"),
    connectTimeoutMs: positiveInteger(values.get("--connect-timeout"), "--connect-timeout", 15) * 1000,
    raknetBackend: raknet,
  };
  const version = values.get("--version");
  const profilesFolder = values.get("--profiles-folder");
  if (version !== undefined) Object.assign(options, { version });
  if (profilesFolder !== undefined) Object.assign(options, { profilesFolder });
  if (values.has("--duration")) {
    Object.assign(options, { durationMs: positiveInteger(values.get("--duration"), "--duration") * 1000 });
  }
  const summary = await captureBedrockSession(options);
  console.log(`${basename(summary.output)}: ${summary.packets} packets captured (${summary.closeReason})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) usage(argv.includes("--help") ? 0 : 2);
  const command = argv[0];
  if (command === "export") return exportCommand(argv.slice(1));
  if (command === "capture") return captureCommand(argv.slice(1));
  throw new TypeError(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
