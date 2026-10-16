// localStorage can throw (private windows, blocked storage); these are per-viewer conveniences only.
export function readSetting(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not persisted; the setting still applies for this visit
  }
}
