/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from "node:assert/strict";
import test from "node:test";
import { startGui } from "../src/gui.js";

test("serves the GUI, capture status, and journal analysis APIs", async () => {
  const gui = await startGui({ openBrowser: false });
  try {
    const page = await fetch(gui.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /CBE-R/);
    assert.match(html, /接続・録画開始/);
    assert.match(html, /coverage/);

    const captureStatus = await fetch(new URL("/api/capture/status", gui.url));
    assert.equal(captureStatus.status, 200);
    assert.deepEqual(await captureStatus.json(), { active: false });

    const journal = `${JSON.stringify({ event: "packet", name: "level_chunk", params: {} })}\n`;
    const response = await fetch(new URL("/api/analyze", gui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journal }),
    });
    assert.equal(response.status, 200);
    const inspection = await response.json() as { summary: { chunkPackets: number }; blocks: number };
    assert.equal(inspection.summary.chunkPackets, 1);
    assert.equal(inspection.blocks, 0);
  } finally {
    await gui.close();
  }
});

test("rejects live capture start without host and username", async () => {
  const gui = await startGui({ openBrowser: false });
  try {
    const response = await fetch(new URL("/api/capture/start", gui.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /host and username/);
  } finally {
    await gui.close();
  }
});
