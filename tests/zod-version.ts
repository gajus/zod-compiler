// oxlint-disable-next-line import/no-nodejs-modules -- need createRequire to read zod/package.json for version detection
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const zodVersion: string = (require("zod/package.json") as { version: string }).version;

/** True if the installed Zod version is >= the given version string (e.g. "4.1") */
export function zodAtLeast(minVersion: string): boolean {
  const [majA = 0, minA = 0] = zodVersion.split(".").map(Number);
  const [majB = 0, minB = 0] = minVersion.split(".").map(Number);
  return majA > majB || (majA === majB && minA >= minB);
}
