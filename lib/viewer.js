// Which files can be shown inside the Command Centre, and how.
//   "pdf"    — sent as it is; the browser's own PDF viewer shows it
//   "image"  — sent as it is
//   "office" — Word, Excel and PowerPoint files on SharePoint: Microsoft makes a PDF copy for the
//              view (nothing is changed or stored); files on the office PC can't be converted
// Anything else (drawings, archives, …) is opened in SharePoint or downloaded as before.
export const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const OFFICE = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pps", ".ppsx", ".rtf", ".odt", ".ods", ".odp"]);
const MAX_VIEW = (Number(process.env.VIEW_MAX_MB) || 150) * 1024 * 1024;

export function viewKind(d) {
  if (!d || d.fromRegister || d.size > MAX_VIEW) return null;
  const remote = d.sourceType === "sharepoint";
  if (remote ? !d.remote : !d.path) return null;
  const ext = String(d.ext || "").toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (IMAGE_MIME[ext]) return "image";
  if (remote && OFFICE.has(ext)) return "office";
  return null;
}

export const viewMime = (d, kind = viewKind(d)) => (kind === "image" ? IMAGE_MIME[String(d.ext).toLowerCase()] : "application/pdf");
