/* Check the shared archive readers and their byte cache. */

import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, load } from "./helpers/browser.js";

installBrowser();

/* Each archive's bytes, served by a FetchSource that counts its requests. */
const fetches = [];
let serve = async (_url, _offset, length) => ({ data: new Uint8Array(length).fill(7).buffer, etag: "e1" });
globalThis.pmtiles.FetchSource = class {
  constructor(url) { this.url = url; }
  getKey() { return this.url; }
  getBytes(offset, length, _signal, etag) {
    fetches.push(`${this.url}|${offset}|${length}`);
    return serve(this.url, offset, length, etag);
  }
};
const { archive, protocol } = await load("js/archive.js");
const count = (key) => fetches.filter((entry) => entry === key).length;

test("one reader per archive, registered with the pmtiles protocol", () => {
  const reader = archive("https://x/a.pmtiles");
  assert.equal(archive("https://x/a.pmtiles"), reader);
  assert.equal(protocol.get("https://x/a.pmtiles"), reader, "MapLibre's reads go through it too");
});

test("bytes are read once and handed out as copies", async () => {
  const { source } = archive("https://x/b.pmtiles");
  const first = await source.getBytes(0, 3);
  const second = await source.getBytes(0, 3);
  assert.equal(count("https://x/b.pmtiles|0|3"), 1);
  assert.equal(second.etag, "e1");
  new Uint8Array(first.data)[0] = 1;
  assert.equal(new Uint8Array(second.data)[0], 7, "a consumer cannot alter the cached bytes");
});

test("a failed read is not cached", async () => {
  const { source } = archive("https://x/c.pmtiles");
  const previous = serve;
  serve = async () => { throw new Error("network"); };
  await assert.rejects(() => source.getBytes(0, 3), /network/);
  serve = previous;
  assert.equal((await source.getBytes(0, 3)).data.byteLength, 3, "the next read fetches again");
  assert.equal(count("https://x/c.pmtiles|0|3"), 2);
});

test("an aborted caller stops waiting while the shared read completes", async () => {
  const { source } = archive("https://x/d.pmtiles");
  const previous = serve;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  serve = async (...args) => { await gate; return previous(...args); };
  const controller = new AbortController();
  const aborted = source.getBytes(0, 3, controller.signal);
  const other = source.getBytes(0, 3);
  controller.abort();
  await assert.rejects(aborted, { name: "AbortError" });
  release();
  assert.equal((await other).data.byteLength, 3);
  serve = previous;
  assert.equal(count("https://x/d.pmtiles|0|3"), 1);
});

test("past the budget, the least recently used bytes go first", async () => {
  const { source } = archive("https://x/e.pmtiles");
  const MB = 1024 * 1024;
  await source.getBytes(0, 30 * MB);
  await source.getBytes(1, 30 * MB);
  await source.getBytes(0, 30 * MB); // touched: now the most recent
  await source.getBytes(2, 30 * MB); // 90 MB: over the 64 MB budget
  await source.getBytes(0, 30 * MB);
  assert.equal(count(`https://x/e.pmtiles|0|${30 * MB}`), 1, "kept");
  await source.getBytes(1, 30 * MB);
  assert.equal(count(`https://x/e.pmtiles|1|${30 * MB}`), 2, "evicted, so read again");
});

test("a replaced archive is read afresh", async () => {
  const { source } = archive("https://x/f.pmtiles");
  await source.getBytes(0, 3); // the header, under ETag e1
  await source.getBytes(5, 3);
  const previous = serve;
  serve = async (_url, _offset, length, etag) => {
    if (etag && etag !== "e2") throw new pmtiles.EtagMismatch("replaced");
    return { data: new Uint8Array(length).buffer, etag: "e2" };
  };
  await assert.rejects(() => source.getBytes(9, 3, undefined, "e1"), pmtiles.EtagMismatch);
  assert.equal((await source.getBytes(0, 3)).etag, "e2", "PMTiles' retry gets the new header");
  await source.getBytes(5, 3);
  assert.equal(count("https://x/f.pmtiles|5|3"), 2, "and none of the old bytes");
  serve = previous;
});
