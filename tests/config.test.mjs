// DEMO_DATA=off hides demo folders, simulated servers and demo SharePoint sites without losing them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-cfg-"));
process.env.DATA_DIR = dir;
const cfgMod = await import("../lib/config.js");
const file = path.join(dir, "config.json");

const stored = {
  sources: [
    { id: "src-pc", path: path.join(cfgMod.DEMO_DIR, "Local-PC") },
    { id: "real", path: "/srv/share" },
    { id: "lookalike", path: cfgMod.DEMO_DIR + "-real" },
  ],
  servers: [{ id: "mon-local", kind: "local" }, { id: "mon-nas", kind: "simulated" }],
  sharepoint: [{ id: "sp-demo", demo: true }, { id: "sp-real", demo: false }],
};
const ids = (a) => a.map((x) => x.id);

test("demo data shows by default", () => {
  delete process.env.DEMO_DATA;
  fs.writeFileSync(file, JSON.stringify(stored));
  cfgMod._resetConfigCache();
  const c = cfgMod.getConfig();
  assert.equal(cfgMod.demoEnabled(), true);
  assert.deepEqual(ids(c.sources), ["src-pc", "real", "lookalike"]);
  assert.deepEqual(ids(c.servers), ["mon-local", "mon-nas"]);
});

test("DEMO_DATA=off hides demo entries, and saving keeps them in the file", () => {
  process.env.DEMO_DATA = "off";
  fs.writeFileSync(file, JSON.stringify(stored));
  cfgMod._resetConfigCache();
  const c = cfgMod.getConfig();
  assert.deepEqual(ids(c.sources), ["real", "lookalike"]);
  assert.deepEqual(ids(c.servers), ["mon-local"]);
  assert.deepEqual(ids(c.sharepoint), ["sp-real"]);

  c.sharepoint.push({ id: "sp-new" });
  cfgMod.saveConfig();
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(ids(onDisk.sources).sort(), ["lookalike", "real", "src-pc"]);
  assert.deepEqual(ids(onDisk.sharepoint).sort(), ["sp-demo", "sp-new", "sp-real"]);

  process.env.DEMO_DATA = "";
  cfgMod._resetConfigCache();
  assert.deepEqual(ids(cfgMod.getConfig().sharepoint).sort(), ["sp-demo", "sp-new", "sp-real"], "switching back on restores them");
});
