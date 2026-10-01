import { AsyncLocalStorage } from "node:async_hooks";

// An explicit anonymous context overrides process credentials. Never mutate env
// for a remote caller: concurrent requests must retain separate credentials.
const credentials = new AsyncLocalStorage<{ key?: string }>();
export function requestCredential(): { key?: string } | undefined {
  return credentials.getStore();
}
export function withRequestCredential<T>(
  key: string | undefined,
  run: () => T,
): T {
  return credentials.run({ key }, run);
}
