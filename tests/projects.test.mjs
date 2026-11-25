// Projects: recognised from folder names, typed by suggestion, confirmed by a person.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bjfc-proj-"));
process.env.DEMO_DATA = "off";
const pr = await import("../lib/projects.js");
const idx = await import("../lib/indexer.js");

test("a project is a coded folder in the projects folder, up to three levels down", () => {
  assert.deepEqual(pr.projectFromFolder("BJFC Projects/ETH11 - Illovo Fire Station/04 Drawings"), { code: "ETH11", name: "ETH11 - Illovo Fire Station" });
  assert.deepEqual(pr.projectFromFolder("BJFC Projects/DoT KZN/DoT Capital Projects/DOT37_D880_Road_Upgrade/Photos"), { code: "DOT37", name: "DOT37 D880 Road Upgrade" });
  assert.equal(pr.projectFromFolder("BJFC Projects/DoT KZN/DoT Capital Projects/DoT75_P197_1_Rehab").code, "DOT75");
  assert.equal(pr.projectFromFolder("BJFC Projects/STA01_St Anne Church").code, "STA01");
  assert.equal(pr.projectFromFolder("BJFC Projects/JOU001HSE Joubert").code, "JOU001");
  for (const f of ["BJFC Projects/BJ-FC Library/SANS", "BJFC Projects/DoT KZN/DoT Capital Projects/P242", "BJFC Projects/DoT KZN/DoT Capital Projects/DOT Monthly Reports", "BJFC Admin/ETH11 stuff", ""]) assert.equal(pr.projectFromFolder(f), null, f);
});

test("types are suggested from the folder names — none, one or several", () => {
  assert.deepEqual(pr.suggestTypes("DOT37 D880 Road Upgrade"), ["Road Upgrades"]);
  assert.deepEqual(pr.suggestTypes("DOT11 P525 Ntuze Bridge"), ["Road Bridges"]);
  assert.deepEqual(pr.suggestTypes("DOT74 P324 Reseal"), ["Road Rehabilitation"]);
  assert.deepEqual(pr.suggestTypes("DOT49 P706 Road Upgrade", "DoT49 - P706 Flood Damage Report"), ["Road Upgrades", "Road Maintenance"]);
  assert.deepEqual(pr.suggestTypes("DOT86 Newcastle Cost Centre"), ["Road Maintenance"]);
  assert.deepEqual(pr.suggestTypes("ETH11 - Illovo Fire Station"), ["Structural - Building"]);
  assert.deepEqual(pr.suggestTypes("ETH12 - KwaMashu AutoHub"), ["Structural - Building"]);
  assert.deepEqual(pr.suggestTypes("ETH06 - Hammarsdale"), []);
});

test("a confirmed project keeps its types; the menu groups files by type, a two-type project under both", () => {
  pr.registerProjects(new Map([["DOT49", new Set(["DOT49 P706 Road Upgrade", "DoT49 - P706 Flood Damage Report"])], ["ETH06", new Set(["ETH06 - Hammarsdale"])], ["DOT11", new Set(["DOT11 P525 Ntuze Bridge"])]]));
  assert.deepEqual(pr.typesOf("DOT49"), ["Road Upgrades", "Road Maintenance"]);
  assert.equal(pr.setProject("NOPE", { types: [] }), null);
  assert.equal(pr.setProject("__proto__", { types: ["Road Bridges"] }), null);
  assert.equal({}.confirmed, undefined, "nothing leaked onto every object");
  assert.deepEqual(pr.typesOf("constructor"), []);
  pr.setProject("ETH06", { types: ["Water and Sanitation", "Not a type"] });
  pr.registerProjects(new Map([["ETH06", new Set(["ETH06 - Hammarsdale Bridge"])]]));
  assert.deepEqual(pr.listProjects().find((p) => p.code === "ETH06"), { code: "ETH06", name: "ETH06 - Hammarsdale", types: ["Water and Sanitation"], confirmed: true });

  const doc = (id, project) => ({ id, name: `${id}.pdf`, relPath: `Documents/BJFC Projects/${id}.pdf`, folder: "Documents/BJFC Projects", ext: ".pdf", size: 1, modified: "2026-01-01T00:00:00Z", sourceId: "s", sourceName: "SP", sourceType: "sharepoint", agentAccess: true, type: "other", text: "", textIndexed: false, meta: {}, area: "Projects", category: "General", project });
  idx.setExtraDocs("p", [doc("a", "DOT49"), doc("b", "DOT49"), doc("c", "ETH06"), doc("d", "DOT11"), doc("e", undefined)]);
  const types = idx.facets().find((a) => a.area === "Projects").types;
  assert.deepEqual(types.map((t) => [t.type, t.files, t.projects.map((p) => p.code)]), [["Road Upgrades", 2, ["DOT49"]], ["Road Bridges", 1, ["DOT11"]], ["Road Maintenance", 2, ["DOT49"]], ["Water and Sanitation", 1, ["ETH06"]], ["none", 1, []]]);
  const ids = (o) => idx.queryDocs(o).rows.map((d) => d.id).sort();
  assert.deepEqual(ids({ ptype: "Road Maintenance" }), ["a", "b"]);
  assert.deepEqual(ids({ ptype: "none" }), ["e"]);
  assert.deepEqual(ids({ project: "ETH06" }), ["c"]);
  assert.deepEqual(idx.queryDocs({ project: "DOT49" }).rows[0].projectTypes, ["Road Upgrades", "Road Maintenance"]);
});
