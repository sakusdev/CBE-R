#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import process from "node:process";
import { decodeJournalToCapture, summarizeJournal } from "./journal.js";
import { captureBedrockSession } from "./live.js";
import type { LiveCaptureOptions } from "./live.js";
import { encodeJavaStructure, encodeJavaStructureGzip } from "./nbt.js";
import { captureBounds, regionFilename, splitBounds } from "./planning.js";
import type { CaptureDocument, Vec3 } from "./types.js";
import { extractJavaStructure, validateCaptureDocument } from "./world.js";

function usage(exitCode = 2): never {
  console.error(`CBE-R

Commands:
  cbe-r capture --host example.org --username ProfileName --output session.ndjson [options]
  cbe-r analyze --input session.ndjson [--json]
  cbe-r decode --input session.ndjson --output capture.json [--strict] [--version <version>]
  cbe-r export --input capture.json --output building.nbt (--from x,y,z --to x,y,z | --auto-bounds) [options]
  cbe-r pipeline --input session.ndjson --output building.nbt (--from x,y,z --to x,y,z | --auto-bounds) [options]

Export/pipeline options:
  --auto-bounds                 Use the complete detected block bounds
  --split <size|x,y,z>          Write multiple bounded NBT files
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

Decode/analyze options:
  --strict                      Reject malformed or unsupported journals
  --json                        Print machine-readable analysis

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

function parseSplit(value: string | undefined): number | Vec3 | undefined {
  if (value === undefined) return undefined;
  if (!value.includes(",")) return positiveInteger(value, "--split");
  const parsed = parseVec3(value, "--split");
  if (parsed.some((entry) => entry <= 0)) throw new TypeError("--split values must be positive integers");
  return parsed;
}

function positiveInteger(value: string | undefined, option: string, fallback?: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${option} must be a positive integer`);
  }
  return parsed;
}

interface ExportOptions {
  readonly output: string;
  readonly from?: Vec3;
  readonly to?: Vec3;
  readonly autoBounds: boolean;
  readonly split?: number | Vec3;
  readonly dataVersion: number;
  readonly compressed: boolean;
  readonly includeAir: boolean;
  readonly includeEntities: boolean;
  readonly unsupported: "barrier" | "air" | "throw";
}

function parseExportOptions(values: Map<string, string>, flags: Set<string>): ExportOptions {
  const output = values.get("--output");
  if (!output) usage();
  const autoBounds = flags.has("--auto-bounds");
  const hasFrom = values.has("--from");
  const hasTo = values.has("--to");
  if (autoBounds && (hasFrom || hasTo)) throw new TypeError("--auto-bounds cannot be combined with --from or --to");
  if (!autoBounds && (!hasFrom || !hasTo)) throw new TypeError("Provide --from and --to, or use --auto-bounds");
  const unsupported = values.get("--unsupported") ?? "barrier";
  if (unsupported !== "barrier" && unsupported !== "air" && unsupported !== "throw") {
    throw new TypeError("--unsupported must be barrier, air, or throw");
  }
  return {
    output,
    ...(hasFrom ? { from: parseVec3(values.get("--from"), "--from") } : {}),
    ...(hasTo ? { to: parseVec3(values.get("--to"), "--to") } : {}),
    autoBounds,
    ...(values.has("--split") ? { split: parseSplit(values.get("--split"))! } : {}),
    dataVersion: positiveInteger(values.get("--data-version"), "--data-version", 3955),
    compressed: !flags.has("--uncompressed"),
    includeAir: flags.has("--include-air"),
    includeEntities: flags.has("--include-entities"),
    unsupported,
  };
}

async function writeOneStructure(document: CaptureDocument, options: ExportOptions, from: Vec3, to: Vec3, output: string): Promise<void> {
  const structure = extractJavaStructure(document, from, to, {
    dataVersion: options.dataVersion,
    includeAir: options.includeAir,
    includeEntities: options.includeEntities,
    unsupportedBlockPolicy: options.unsupported,
  });
  const encoded = options.compressed ? encodeJavaStructureGzip(structure) : encodeJavaStructure(structure);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, encoded);
  const barriers = structure.blocks.filter(({ state }) => state.name === "minecraft:barrier").length;
  console.log(`${basename(output)}: ${structure.blocks.length} blocks, ${structure.entities?.length ?? 0} entities, ${encoded.length} bytes`);
  if (barriers > 0) console.warn(`Warning: ${barriers} unsupported block states were replaced with barriers`);
}

async function writeStructures(document: CaptureDocument, options: ExportOptions): Promise<void> {
  const [from, to] = options.autoBounds ? captureBounds(document) : [options.from!, options.to!];
  if (options.split === undefined) {
    await writeOneStructure(document, options, from, to, options.output);
    return;
  }
  const regions = splitBounds(from, to, options.split);
  for (const region of regions) {
    await writeOneStructure(document, options, region.from, region.to, regionFilename(options.output, region.index));
  }
  console.log(`Wrote ${regions.length} structure files`);
}

async function exportCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--auto-bounds", "--uncompressed", "--include-air", "--include-entities"]);
  const input = values.get("--input");
  if (!input) usage();
  const parsed: unknown = JSON.parse(await readFile(input, "utf8"));
  validateCaptureDocument(parsed);
  await writeStructures(parsed, parseExportOptions(values, flags));
}

async function analyzeCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--json"]);
  const input = values.get("--input");
  if (!input) usage();
  const summary = summarizeJournal(await readFile(input, "utf8"));
  if (flags.has("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`${basename(input)}: ${summary.records} records, ${summary.packets} packets, ${summary.chunkPackets} chunk packets, ${summary.malformedLines} malformed lines`);
  for (const [name, count] of Object.entries(summary.packetNames).sort((a, b) => b[1] - a[1])) console.log(`${name}: ${count}`);
}

async function decodeCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--strict"]);
  const input = values.get("--input");
  const output = values.get("--output");
  if (!input || !output) usage();
  const document = decodeJournalToCapture(await readFile(input, "utf8"), {
    strict: flags.has("--strict"),
    ...(values.has("--version") ? { protocolVersion: values.get("--version")! } : {}),
  });
  await writeFile(output, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`${basename(output)}: ${document.blocks.length} blocks, ${document.entities?.length ?? 0} entities`);
}

async function pipelineCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--strict", "--auto-bounds", "--uncompressed", "--include-air", "--include-entities"]);
  const input = values.get("--input");
  if (!input) usage();
  const document = decodeJournalToCapture(await readFile(input, "utf8"), {
    strict: flags.has("--strict"),
    ...(values.has("--version") ? { protocolVersion: values.get("--version")! } : {}),
  });
  await writeStructures(document, parseExportOptions(values, flags));
}

async function captureCommand(argv: readonly string[]): Promise<void> {
  const { values, flags } = parseTokens(argv, ["--offline"]);
  const host = values.get("--host");
  const username = values.get("--username");
  const output = values.get("--output");
  if (!host || !username || !output) usage();
  const raknet = values.get("--raknet") ?? "jsp-raknet";
  if (raknet !== "jsp-raknet" && raknet !== "raknet-node" && raknet !== "raknet-native") throw new TypeError("--raknet must be jsp-raknet, raknet-node, or raknet-native");
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
  if (values.has("--duration")) Object.assign(options, { durationMs: positiveInteger(values.get("--duration"), "--duration") * 1000 });
  const summary = await captureBedrockSession(options);
  console.log(`${basename(summary.output)}: ${summary.packets} packets captured (${summary.closeReason})`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help")) usage(argv.includes("--help") ? 0 : 2);
  const command = argv[0];
  if (command === "export") return exportCommand(argv.slice(1));
  if (command === "capture") return captureCommand(argv.slice(1));
  if (command === "analyze") return analyzeCommand(argv.slice(1));
  if (command === "decode") return decodeCommand(argv.slice(1));
  if (command === "pipeline") return pipelineCommand(argv.slice(1));
  throw new TypeError(`Unknown command: ${command}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
