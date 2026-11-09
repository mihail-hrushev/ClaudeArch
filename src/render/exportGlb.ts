import type { Scene } from "@babylonjs/core/scene";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

/** The browser's "Save as" dialog (File System Access API; Chrome and Edge). */
type SavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }> }>;

/**
 * The structure as a binary glTF blob. glTF is Y-up and in metres, the scene Z-up and in
 * centimetres, so the meshes are hung under a root node that turns and scales them for the export,
 * then put back. Only the meshes given go into the file (no sky, ground, axes or helpers).
 */
export async function structureGlb(scene: Scene, meshes: readonly Mesh[], fileName: string): Promise<Blob> {
  const root = new TransformNode("structure", scene);
  root.rotation.x = -Math.PI / 2; // Z-up to Y-up
  root.scaling.setAll(0.01); // centimetres to metres
  const exported = new Set<unknown>([root, ...meshes]);
  try {
    // Loaded on first use: the exporter is not needed to view the model.
    const { GLTF2Export } = await import("@babylonjs/serializers/glTF/2.0/glTFSerializer");
    for (const mesh of meshes) mesh.parent = root;
    const data = await GLTF2Export.GLBAsync(scene, fileName, { shouldExportNode: (node) => exported.has(node) });
    const file = Object.values(data.files)[0];
    return file instanceof Blob ? file : new Blob([file], { type: "model/gltf-binary" });
  } finally {
    for (const mesh of meshes) mesh.parent = null;
    root.dispose();
  }
}

/**
 * Saving the structure as a binary glTF (.glb):
 *   Ctrl+S or the "Save GLB" button (top right)  a "Save as" dialog to pick the folder and name
 *                                                (a plain download where the browser has no such dialog)
 *   G                                            a plain download to the browser's downloads folder
 * Only the structure goes into the file (see structureGlb above).
 */
export function installGlbExport(scene: Scene, meshes: readonly Mesh[], fileName: string): void {
  const name = `${fileName}.glb`;
  let busy = false;
  const button = document.createElement("button");
  button.textContent = "Save GLB";
  button.title = "Save the structure as a .glb file (Ctrl+S: save as, G: download)";
  Object.assign(button.style, {
    position: "absolute",
    top: "8px",
    right: "8px",
    padding: "6px 12px",
    font: "12px ui-monospace, Consolas, monospace",
    color: "#e8eef2",
    background: "rgba(10, 12, 16, 0.7)",
    border: "1px solid rgba(232, 238, 242, 0.35)",
    borderRadius: "4px",
    cursor: "pointer",
    zIndex: "10",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(button);

  const flash = (text: string) => {
    button.textContent = text;
    setTimeout(() => (button.textContent = "Save GLB"), 2500);
  };

  const download = (blob: Blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  const save = async (saveAs: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      // The dialog opens first, while the key press or click still counts as the user's gesture.
      const target = saveAs && picker
        ? await picker({ suggestedName: name, types: [{ description: "glTF binary", accept: { "model/gltf-binary": [".glb"] } }] })
        : undefined;
      button.textContent = "Saving…";
      const blob = await structureGlb(scene, meshes, fileName);
      if (target) {
        const writable = await target.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        download(blob);
      }
      flash("Saved");
    } catch (e) {
      if ((e as Error).name === "AbortError") button.textContent = "Save GLB"; // dialog cancelled
      else {
        console.error("GLB export failed", e);
        flash("Export failed");
      }
    } finally {
      busy = false;
    }
  };

  button.addEventListener("click", () => void save(true));
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault(); // not the browser's "save page"
      void save(true);
    } else if ((e.key === "g" || e.key === "G") && !e.ctrlKey && !e.metaKey && !(e.target instanceof HTMLInputElement)) {
      void save(false);
    }
  });
}
