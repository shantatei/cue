import { fileURLToPath } from "node:url";

// Compiled modules live in dist/server/. Persistent user data stays outside dist/.
export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DATA = `${ROOT}data/`;
export const SCRIPTS = `${ROOT}scripts/`;
