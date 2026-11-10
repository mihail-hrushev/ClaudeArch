/**
 * Model picker: "M" toggles a panel listing the available models (built-in ones and the structure
 * documents); clicking one loads it, as `?model=<key>` with the camera of its own view.
 */
export function installModelPanel(groups: readonly { readonly title: string; readonly keys: readonly string[] }[], current: string): HTMLDivElement {
  const panel = document.createElement("div");
  panel.hidden = true;
  Object.assign(panel.style, {
    position: "absolute",
    top: "130px",
    left: "8px",
    minWidth: "200px",
    maxHeight: "calc(100vh - 150px)",
    overflowY: "auto",
    padding: "8px 0",
    font: "13px/1.4 system-ui, sans-serif",
    color: "#e8eef2",
    background: "rgba(10, 12, 16, 0.78)",
    borderRadius: "6px",
    zIndex: "20",
    userSelect: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  const heading = (text: string) => {
    const h = document.createElement("div");
    h.textContent = text;
    Object.assign(h.style, { padding: "6px 14px 2px", fontSize: "11px", letterSpacing: "0.06em", textTransform: "uppercase", color: "#8d99a6" });
    panel.appendChild(h);
  };

  const open = (key: string) => {
    const url = new URL(location.href);
    url.searchParams.set("model", key);
    url.searchParams.delete("cam"); // the new model starts from its own view
    location.href = url.toString();
  };

  heading("Models · M");
  for (const group of groups) {
    if (!group.keys.length) continue;
    heading(group.title);
    for (const key of group.keys) {
      const item = document.createElement("div");
      item.textContent = key;
      const selected = key === current;
      Object.assign(item.style, {
        padding: "3px 14px",
        cursor: selected ? "default" : "pointer",
        color: selected ? "#ffffff" : "#d0d8e0",
        background: selected ? "rgba(90, 140, 220, 0.45)" : "transparent",
      } satisfies Partial<CSSStyleDeclaration>);
      if (!selected) {
        item.addEventListener("mouseenter", () => (item.style.background = "rgba(255, 255, 255, 0.12)"));
        item.addEventListener("mouseleave", () => (item.style.background = "transparent"));
        item.addEventListener("click", () => open(key));
      }
      panel.appendChild(item);
    }
  }
  document.body.appendChild(panel);

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement) return;
    if (e.key === "m" || e.key === "M") panel.hidden = !panel.hidden;
    else if (e.key === "Escape") panel.hidden = true;
  });
  return panel;
}
