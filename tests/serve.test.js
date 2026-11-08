/*
 * The development server: byte ranges, mount containment and cache headers,
 * over raw socket requests. HTTP clients normalize traversal paths before
 * sending them, hiding the cases these tests need to exercise.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createServer } from "../scripts/serve.mjs";

const BODY = "0123456789abcdef";

let tmp;
let server;
let port;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "glace-serve-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(tmp, file)), { recursive: true });
    fs.writeFileSync(path.join(tmp, file), text);
  };
  write("web/index.html", "<!doctype html>");
  write("web/js/app.js", "// app");
  write("web/js/lib.mjs", "export {};");
  write("web/docs/index.html", "<!doctype html>");
  write("tiles/sample.pmtiles", BODY);
  write("tiles/with space.json", "{}");
  write("tiles/nested/deep.pmtiles", BODY);
  write("tiles/locked.pmtiles", BODY);
  fs.chmodSync(path.join(tmp, "tiles", "locked.pmtiles"), 0);
  /* Outside the mount, and named so a successful read is unmistakable. */
  write("secret.txt", "ESCAPED");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(tmp, "tiles", "link.txt"));

  server = createServer({ webDir: path.join(tmp, "web"), tilesDir: path.join(tmp, "tiles") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Send a request line verbatim, without any client-side normalization. */
function get(target, headers = "", method = "GET") {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`${method} ${target} HTTP/1.0\r\nHost: t\r\n${headers}\r\n`);
    });
    socket.setTimeout(5000, () => socket.destroy(new Error("timed out")));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const raw = Buffer.concat(chunks).toString("latin1");
      const split = raw.indexOf("\r\n\r\n");
      const [statusLine, ...lines] = raw.slice(0, split).split("\r\n");
      const fields = Object.fromEntries(
        lines.map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      resolve({ status: Number(statusLine.split(" ")[1]), headers: fields, body: raw.slice(split + 4) });
    });
  });
}

/** The request is refused, and none of the target file comes back. */
async function assertBlocked(target, headers = "") {
  const response = await get(target, headers);
  assert.equal(response.status, 404, `${target} was served`);
  assert.doesNotMatch(response.body, /ESCAPED/);
}

describe("path containment", () => {
  test("serves a file in the mount", async () => {
    const response = await get("/tiles/sample.pmtiles");
    assert.equal(response.status, 200);
    assert.equal(response.body, BODY);
  });

  test("serves a nested file", async () => {
    assert.equal((await get("/tiles/nested/deep.pmtiles")).status, 200);
  });

  test("percent-decodes the name", async () => {
    /* The containment check must not cost ordinary escaped characters. */
    assert.equal((await get("/tiles/with%20space.json")).status, 200);
  });

  test("rejects a .. escape", async () => {
    /*
     * Exactly one level up from the mount, which is where secret.txt is: a
     * deeper climb would be stopped by the filesystem rather than by the
     * check under test, and would pass even with the check removed.
     */
    await assertBlocked("/tiles/../secret.txt");
  });

  test("rejects a .. escape from a subdirectory", async () => {
    await assertBlocked("/tiles/nested/../../secret.txt");
  });

  test("rejects an encoded .. escape", async () => {
    /* The path is decoded before the check, so an encoded climb cannot walk past it either. */
    await assertBlocked("/tiles/%2e%2e/secret.txt");
    await assertBlocked("/tiles/..%2fsecret.txt");
  });

  test("rejects a symlink that leads out of the mount", async () => {
    await assertBlocked("/tiles/link.txt");
  });

  test("rejects an absolute-looking path", async () => {
    /* A leading slash must not discard the mount and resolve against the filesystem root. */
    assert.equal((await get("/tiles//etc/hostname")).status, 404);
  });

  test("rejects a malformed escape", async () => {
    assert.equal((await get("/tiles/%zz")).status, 404);
  });

  test("a NUL in the path is missing, and the server keeps serving", async () => {
    /* The file system throws on a NUL instead of answering that nothing is there. */
    assert.equal((await get("/a%00b")).status, 404);
    assert.equal((await get("/tiles/a%00b")).status, 404);
    assert.equal((await get("/index.html")).status, 200);
  });

  test("an escape is rejected for a range request too", async () => {
    await assertBlocked("/tiles/../secret.txt", "Range: bytes=0-3\r\n");
  });

  test("the web root is still served", async () => {
    assert.equal((await get("/index.html")).status, 200);
    assert.equal((await get("/js/app.js")).status, 200);
  });

  test("a climb out of the web root stops at the root", async () => {
    await assertBlocked("/../secret.txt");
    await assertBlocked("/js/../../secret.txt");
  });

  test("a directory serves its index.html, and its address gains a slash", async () => {
    assert.equal((await get("/")).status, 200);
    assert.equal((await get("/docs/")).status, 200);
    const redirect = await get("/docs?tiles=x");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, "/docs/?tiles=x");
  });

  test("a redirect stays on this host", async () => {
    /* "//docs/" would name the host "docs". */
    const redirect = await get("//docs?tiles=x");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, "/docs/?tiles=x");
  });

  test("an unreadable file is missing, not a dropped connection", { skip: process.getuid?.() === 0 && "root reads anything" }, async () => {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      assert.equal((await get("/tiles/locked.pmtiles", "Range: bytes=0-3\r\n")).status, 404);
    } finally {
      console.error = original;
    }
    assert.match(errors.join("\n"), /locked\.pmtiles/);
  });
});

describe("range requests", () => {
  test("no range returns the whole body", async () => {
    const response = await get("/tiles/sample.pmtiles");
    assert.equal(response.status, 200);
    assert.equal(response.body, BODY);
  });

  test("a closed range", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=0-3\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, "0123");
    assert.equal(response.headers["content-range"], `bytes 0-3/${BODY.length}`);
    assert.equal(response.headers["content-length"], "4");
  });

  test("an open-ended range", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=10-\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, BODY.slice(10));
  });

  test("a suffix range", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=-4\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, "cdef");
  });

  test("a suffix longer than the file is clamped", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=-9999\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, BODY);
  });

  test("an end past the file is clamped", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=12-9999\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, BODY.slice(12));
  });

  test("the last byte", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=15-15\r\n");
    assert.equal(response.status, 206);
    assert.equal(response.body, "f");
  });

  test("a start past the end is unsatisfiable", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=9999-\r\n");
    assert.equal(response.status, 416);
    assert.equal(response.headers["content-range"], `bytes */${BODY.length}`);
  });

  test("an inverted range is unsatisfiable", async () => {
    assert.equal((await get("/tiles/sample.pmtiles", "Range: bytes=5-2\r\n")).status, 416);
  });

  test("a zero-length suffix is unsatisfiable", async () => {
    assert.equal((await get("/tiles/sample.pmtiles", "Range: bytes=-0\r\n")).status, 416);
  });

  test("a range naming neither end is ignored", async () => {
    /* `bytes=-` matches the grammar with both groups empty: the whole body follows. */
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=-\r\n");
    assert.equal(response.status, 200);
    assert.equal(response.body, BODY);
  });

  test("an unparseable range is ignored", async () => {
    const response = await get("/tiles/sample.pmtiles", "Range: bytes=abc\r\n");
    assert.equal(response.status, 200);
    assert.equal(response.body, BODY);
  });

  test("a range on a missing file", async () => {
    assert.equal((await get("/tiles/nope.pmtiles", "Range: bytes=0-3\r\n")).status, 404);
  });

  test("HEAD gives the size without a body", async () => {
    const response = await get("/tiles/sample.pmtiles", "", "HEAD");
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-length"], String(BODY.length));
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(response.body, "");
  });

  test("other methods are not implemented", async () => {
    assert.equal((await get("/index.html", "", "POST")).status, 501);
  });
});

describe("cache headers", () => {
  test("the page shell is never stored", async () => {
    /* A stale js/app.js leaves the page silently rendering the old version. */
    for (const target of ["/", "/index.html", "/js/app.js"]) {
      assert.match((await get(target)).headers["cache-control"], /no-store/, target);
    }
  });

  test("library modules are never stored", async () => {
    /* MapLibre ships .mjs; a stale copy keeps running after npm moves it. */
    const response = await get("/js/lib.mjs");
    assert.match(response.headers["cache-control"], /no-store/);
    assert.equal(response.headers["content-type"], "text/javascript");
  });

  test("archives are cacheable", async () => {
    assert.equal((await get("/tiles/sample.pmtiles")).headers["cache-control"], undefined);
  });
});
