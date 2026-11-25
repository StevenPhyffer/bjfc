// Projects and their types. A project is a folder named "<CODE> <name>" inside the library's
// projects folder ("ETH11 - Illovo Fire Station", "DoT KZN/DoT Capital Projects/DOT37_D880_Road_Upgrade").
// Each project has one or more types from BJFC's own list; every file of the project inherits
// them. Types are suggested from the folder names and then confirmed (or corrected) by a person
// under Project types — the confirmed answer is never overwritten by a suggestion.
import { getConfig, saveConfig } from "./config.js";

export const PROJECT_TYPES = ["Road Upgrades", "Road Bridges", "Road Rehabilitation", "Road Maintenance", "Structural - Building", "Water and Sanitation"];

const CODE = /^([A-Za-z]{2,5})[ _-]?(\d{1,3})(?!\d)/;
const key = (m) => (m[1] + m[2]).toUpperCase();

// "BJFC Projects/DoT KZN/DoT Capital Projects/DOT37_D880_Road_Upgrade/Drawings" → { code: "DOT37", name: "DOT37 D880 Road Upgrade" }
export function projectFromFolder(folder) {
  const segs = String(folder || "").split("/");
  if (!/projects?\b/i.test(segs[0] || "")) return null;
  for (const seg of segs.slice(1, 4)) {
    const m = seg.match(CODE);
    if (m) return { code: key(m), name: seg.replace(/_/g, " ").replace(/\s+/g, " ").trim() };
  }
  return null;
}

const RULES = [
  ["Road Bridges", /\bbridges?\b|\bculverts?\b/],
  ["Road Upgrades", /\bupgrad(e|es|ing)\b|\bgravel to\b|\bnew road\b/],
  ["Road Rehabilitation", /\brehab(ilitation)?\b|\breseal(ing)?\b|\bresurfac/],
  ["Road Maintenance", /\bmaintenance\b|\bcost cent(re|er)\b|\bflood damage\b|\bpothole|\bblading\b|\bpatching\b/],
  ["Water and Sanitation", /\bwater\b|\bsanitation\b|\bsewer(age)?\b|\breservoir\b|\bpipeline\b|\breticulation\b|\bwwtw\b|\bwaste ?water\b/],
  ["Structural - Building", /\bfire station\b|\bhall\b|\bchurch\b|\bschool\b|\bprimary\b|\bclinic\b|\bhospital\b|\b\w*hub\b|\bretail\b|\bwholesale\b|\bhouse\b|\bhse\b|\bbuilding\b|\bclub ?med\b|\boffices?\b|\bwarehouse\b|\bstructur/],
];
// Types a project's folder names point to (possibly none, possibly several).
export function suggestTypes(...names) {
  const hay = names.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return RULES.filter(([, re]) => re.test(hay)).map(([t]) => t);
}

const store = () => (getConfig().projects ||= {});
// Own entries only: a code comes from folder names and from requests, so "__proto__" must find nothing.
const get = (code) => (code && Object.hasOwn(store(), code) ? store()[code] : undefined);
export const typesOf = (code) => get(code)?.types || [];
export const projectName = (code) => get(code)?.name || code;

// After a listing: found = Map(code → Set of folder names). New projects are added with suggested
// types; unconfirmed ones are re-suggested (a second folder can add a type); confirmed ones only
// ever gain a name.
export function registerProjects(found) {
  const all = store();
  let changed = false;
  for (const [code, names] of found) {
    const list = [...names];
    const p = get(code);
    if (!p) { all[code] = { name: list[0], types: suggestTypes(...list), confirmed: false }; changed = true; }
    else if (!p.confirmed) {
      const types = suggestTypes(...list);
      if (types.join("|") !== p.types.join("|")) { p.types = types; changed = true; }
    }
  }
  if (changed) saveConfig();
}

export function setProject(code, { types, name }) {
  const p = get(String(code).toUpperCase());
  if (!p) return null;
  if (Array.isArray(types)) { p.types = PROJECT_TYPES.filter((t) => types.includes(t)); p.confirmed = true; }
  if (typeof name === "string" && name.trim()) p.name = name.trim().slice(0, 120);
  saveConfig();
  return p;
}

export const listProjects = () => Object.entries(store()).map(([code, p]) => ({ code, ...p })).sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
