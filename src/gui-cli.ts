#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import process from "node:process";
import { startGui } from "./gui.js";

function parsePort(argv: readonly string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index < 0) return undefined;
  const port = Number(argv[index + 1]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError("--port must be between 0 and 65535");
  return port;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log("Usage: cbe-r-gui [--port <number>] [--no-open]");
    return;
  }
  const gui = await startGui({
    ...(parsePort(argv) !== undefined ? { port: parsePort(argv)! } : {}),
    openBrowser: !argv.includes("--no-open"),
  });
  console.log(`CBE-R GUI: ${gui.url}`);
  console.log("Press Ctrl+C to stop.");
  const stop = async (): Promise<void> => { await gui.close(); process.exit(0); };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
