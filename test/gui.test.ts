/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { startGui } from "../src/gui.js";

test("serves the GUI and journal analysis API", async () => {
  const gui = await startGui({ openBrowser: false });
  try {
    const page = await fetch(gui.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CBE-R/);

    const response = await fetch(new URL("/api/analyze", gui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journal: `${JSON.stringify({ event: "packet", name: "level_chunk", params: {} })}\n` }),
    });
    assert.equal(response.status, 200);
    const summary = await response.json() as { chunkPackets: number };
    assert.equal(summary.chunkPackets, 1);
  } finally {
    await gui.close();
  }
});
