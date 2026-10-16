export const SHORTCUTS: { group: string; items: { keys: string[]; label: string }[] }[] = [
  {
    group: "Anywhere",
    items: [
      { keys: ["mod", "K"], label: "Search everything" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
      { keys: ["Esc"], label: "Close a panel or dialog" },
    ],
  },
  {
    group: "Inbox",
    items: [
      { keys: ["J"], label: "Next item" },
      { keys: ["K"], label: "Previous item" },
      { keys: ["Enter"], label: "Open item" },
      { keys: ["A"], label: "Approve" },
      { keys: ["E"], label: "Edit" },
      { keys: ["X"], label: "Select for bulk approval" },
    ],
  },
];

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function keyLabel(key: string): string {
  if (key === "mod") return isMac ? "⌘" : "Ctrl";
  return key;
}
