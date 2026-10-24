import { detectLinux } from "./detect/linux";
import { detectWindows, genericDetection } from "./detect/windows";
import type { Detection } from "./detect/shared";

export type { Detection } from "./detect/shared";

export async function detectDevice(): Promise<Detection> {
  if (process.platform === "linux") return detectLinux();
  if (process.platform === "win32") return detectWindows();
  return genericDetection(undefined, `Platform ${process.platform} is not supported for sensor reads yet.`);
}
