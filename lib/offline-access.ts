export type NavigationMode = "client" | "document";

export function canOpenOfflineResource(isOnline: boolean, hasCachedResource: boolean): boolean {
  return isOnline || hasCachedResource;
}

export function getNavigationMode(isOnline: boolean): NavigationMode {
  return isOnline ? "client" : "document";
}
