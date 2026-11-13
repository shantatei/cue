import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

// Compiled modules live in dist/server/. Persistent user data stays outside dist/.
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA = process.env.CUE_DATA_DIR ? resolve(process.env.CUE_DATA_DIR) + sep : `${ROOT}data/`;
export const SCRIPTS = `${ROOT}scripts/`;
