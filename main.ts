import {
  App,
  Plugin,
  TFile,
  Modal,
  normalizePath,
  Notice
} from "obsidian";

export default class ImageOrganizerPlugin extends Plugin {

  dryRun = true;

  async onload() {
    this.addCommand({
      id: "preview-image-organization",
      name: "Preview Image Organization (Dry Run)",
      callback: () => this.organizeImages(true)
    });

    this.addCommand({
      id: "apply-image-organization",
      name: "Apply Image Organization (Move Files)",
      callback: () => this.organizeImages(false)
    });
  }

  async organizeImages(dryRun: boolean) {
    const vault = this.app.vault;
    const files = vault.getFiles();

    const imageRefs = await this.mapImageReferences(files);
    const preview: string[] = [];

    for (const file of files) {
      if (!file.extension.match(/png|jpg|jpeg/i)) continue;

      const referencedIn = imageRefs.get(file.name);
      const year = this.extractYear(file.name) ?? "Unknown";

      let targetPath: string | null = null;
      let reason = "";

      if (referencedIn === "gamereview.md") {
        targetPath = `notes/${year}/Other/Game/${file.name}`;
        reason = "Referenced in gamereview.md";
      } else {
        const date = this.extractDate(file.name);
        if (!date) continue;

        targetPath = `notes/${date.year}/${date.month}/${date.full}/${file.name}`;
        reason = "Date from filename";
      }

      preview.push(
        `• ${file.name}\n` +
        `  FROM: ${file.path}\n` +
        `  TO:   ${targetPath}\n` +
        `  WHY:  ${reason}\n`
      );

      if (!dryRun) {
        await vault.createFolder(targetPath.split("/").slice(0, -1).join("/"))
          .catch(() => {});
        await vault.rename(file, normalizePath(targetPath));
      }
    }

    if (dryRun) {
      new PreviewModal(this.app, preview).open();
    } else {
      new Notice("Images organized successfully.");
    }
  }

  async mapImageReferences(files: TFile[]) {
    const map = new Map<string, string>();

    for (const file of files) {
      if (file.extension !== "md") continue;

      const content = await this.app.vault.read(file);
      const matches = content.matchAll(/!\[\[([^\]]+)\]\]|!\[.*?\]\((.*?)\)/g);

      for (const match of matches) {
        const image = match[1] || match[2];
        if (image) map.set(image, file.name);
      }
    }
    return map;
  }

  extractYear(name: string): string | null {
    return name.match(/(\d{4})/)?.[1] ?? null;
  }

  extractDate(name: string) {
    const m = name.match(/(\d{4})(\d{2})(\d{2})|(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;

    const year = m[1] || m[4];
    const monthNum = m[2] || m[5];
    const day = m[3] || m[6];

    const monthNames: Record<string, string> = {
      "01": "January", "02": "February", "03": "March",
      "04": "April", "05": "May", "06": "June",
      "07": "July", "08": "August", "09": "September",
      "10": "October", "11": "November", "12": "December"
    };

    return {
      year,
      month: monthNames[monthNum],
      full: `${year}-${monthNum}-${day}`
    };
  }
}

/* ---------- Preview Modal ---------- */

class PreviewModal extends Modal {
  constructor(app: App, private lines: string[]) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Image Organization – Dry Run Preview" });

    const pre = contentEl.createEl("pre");
    pre.setText(this.lines.join("\n"));

    contentEl.createEl("p", {
      text: "Nothing has been moved yet. Run the Apply command to proceed."
    });
  }
}








