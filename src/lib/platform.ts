// Platform-aware UI labels. Reads from `document.documentElement.dataset.platform`
// which is populated at app boot by `platform()` from `@tauri-apps/plugin-os`.
//
// The `keyring` crate maps to:
//   macOS    → macOS Keychain (Security framework)
//   Windows  → Windows Credential Manager (wincred)
//   Linux    → Secret Service (libsecret) — usually GNOME Keyring or KWallet

export type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";

export function currentPlatform(): Platform {
  const p = document.documentElement.dataset.platform;
  if (p === "macos" || p === "windows" || p === "linux" || p === "ios" || p === "android") {
    return p;
  }
  return "unknown";
}

/** Human-readable name of the OS-native secret store, used in copy. */
export function secretStoreName(): string {
  switch (currentPlatform()) {
    case "macos": return "macOS Keychain";
    case "windows": return "Windows Credential Manager";
    case "linux": return "system keyring";
    default: return "system credential store";
  }
}
