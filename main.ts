import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, normalizePath, Notice } from "obsidian";

// =====================
// Settings
// =====================
interface OrganizerSettings {
  dryRun: boolean;
  maskSensitive: boolean;
}

const DEFAULT_SETTINGS: OrganizerSettings = {
  dryRun: true,
  maskSensitive: false,
};

// =====================
// Main Plugin
// =====================
export default class ImageOrganizerPlugin extends Plugin {
  settings: OrganizerSettings;
  leaveAllInPlace: boolean = false;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new OrganizerSettingTab(this.app, this));

    this.addCommand({
      id: "run-image-organizer",
      name: "Run Image & Audio Organizer",
      callback: () => this.runOrganizer(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // =====================
  // Main Organizer
  // =====================
  async runOrganizer() {
    const vault = this.app.vault;
    const files = vault.getFiles();
    const logLines: string[] = [];
    const preview: string[] = [];

    const months: Record<string, string> = {
      "01": "January", "02": "February", "03": "March", "04": "April",
      "05": "May", "06": "June", "07": "July", "08": "August",
      "09": "September", "10": "October", "11": "November", "12": "December"
    };

    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic"];
    const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac", "aac"];

    // =====================
    // Preprocess notes for linked files
    // =====================
    const fileToLinkedNoteDate: Record<string, Date> = {};

    for (const mdFile of files.filter(f => f.extension === "md")) {
      const content = await vault.read(mdFile);
      const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
      const mdLinks = [...content.matchAll(/\[.*?\]\((.*?)\)/g)].map(m => m[1]);
      const allLinks = [...wikiLinks, ...mdLinks];

      const dateMatch = mdFile.path.match(/(\d{4})-(\d{2})-(\d{2})/);
      let noteDate: Date | null = null;
      if (dateMatch) {
        noteDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
      }

      if (noteDate) {
        for (const link of allLinks) {
          const normalized = normalizePath(link);
          fileToLinkedNoteDate[normalized] = noteDate;
        }
      }
    }

    // =====================
    // Process each file
    // =====================
    for (const file of files) {
      const ext = file.extension.toLowerCase();
      if (![...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS].includes(ext)) {
        const msg = `[SKIP] Unsupported type: ${file.path}`;
        preview.push(msg); logLines.push(msg);
        continue;
      }

      let year: string | null = null;
      let month: string | null = null;
      let day: string | null = null;
      let reason = "";
      let usedDate: Date | null = null;

      // Prefer linked note date if exists
      if (fileToLinkedNoteDate[file.path]) {
        usedDate = fileToLinkedNoteDate[file.path];
        year = String(usedDate.getFullYear());
        month = String(usedDate.getMonth() + 1).padStart(2, "0");
        day = String(usedDate.getDate()).padStart(2, "0");
        reason = "Linked note date";
      }

      // Parse filename for date if no linked note date
      if (!year || !month || !day) {
        const matchNumeric = file.name.match(/(\d{4})(\d{2})(\d{2})/);
        const matchMac = file.name.match(/(\d{4})-(\d{2})-(\d{2})/);

        if (matchNumeric) {
          [year, month, day] = matchNumeric.slice(1, 4);
          reason = "Filename YYYYMMDD";
        } else if (matchMac) {
          [year, month, day] = matchMac.slice(1, 4);
          reason = "Filename YYYY-MM-DD";
        }
      }

      // Audio fallback to file stats
      if ((!year || !month || !day) && AUDIO_EXTENSIONS.includes(ext)) {
        const stats = await vault.adapter.stat(file.path);
        const created = new Date(stats.birthtime);
        const modified = new Date(stats.mtime);

        if (!usedDate) {
          if (created.toDateString() !== modified.toDateString()) {
            await new DateConflictModal(this.app, this, file.name, file.path, created, modified, async (chosen: Date | null) => {
              if (chosen) {
                usedDate = chosen;
                year = String(chosen.getFullYear());
                month = String(chosen.getMonth() + 1).padStart(2, "0");
                day = String(chosen.getDate()).padStart(2, "0");
                reason = "User choice (date conflict)";
              }
            }).open();
          } else {
            usedDate = created;
            year = String(usedDate.getFullYear());
            month = String(usedDate.getMonth() + 1).padStart(2, "0");
            day = String(usedDate.getDate()).padStart(2, "0");
            reason = "File created date";
          }
        }
      }

      if (!year || !month || !day) {
        const msg = `[SKIP] ${this.maskName(file.path)} | Reason: Unknown date`;
        preview.push(msg); logLines.push(msg);
        continue;
      }

      const monthName = months[month] ?? "Unknown";
      if (monthName === "Unknown") {
        const msg = `[SKIP] ${this.maskName(file.path)} | Reason: Unknown month`;
        preview.push(msg); logLines.push(msg);
        continue;
      }

      // Determine target path
      let targetPath: string;
      if (file.path.toLowerCase().includes("gamereview.md")) {
        targetPath = normalizePath(`${year}/Other/Game/${file.name}`);
      } else {
        targetPath = normalizePath(`${year}/${monthName}/${year}-${month}-${day}/${file.name}`);
      }

      // Include linked note in logs if exists
      const linkedFrom = fileToLinkedNoteDate[file.path] ? ` | Linked from note` : "";

      const dryTag = this.settings.dryRun ? "[DRY RUN] " : "";
      const logMsg = `${dryTag}${this.maskName(file.path)} → ${targetPath} | Date used: ${year}-${month}-${day} | Reason: ${reason}${linkedFrom}`;
      preview.push(logMsg); logLines.push(logMsg);
    }

    // =====================
    // Check broken links in markdown
    // =====================
    const mdFiles = files.filter(f => f.extension.toLowerCase() === "md");

    for (const mdFile of mdFiles) {
      const content = await vault.read(mdFile);

      const wikiLinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);
      const mdLinks = [...content.matchAll(/\[.*?\]\((.*?)\)/g)].map(m => m[1]);
      const allLinks = [...wikiLinks, ...mdLinks];

      for (const link of allLinks) {
        let targetPath = normalizePath(link);
        if (!targetPath.endsWith(".md") &&
            !IMAGE_EXTENSIONS.includes(targetPath.split(".").pop()!) &&
            !AUDIO_EXTENSIONS.includes(targetPath.split(".").pop()!)) {
          targetPath += ".md"; // assume markdown if no extension
        }

        const exists = await vault.adapter.exists(targetPath);
        if (!exists) {
          const msg = `[BROKEN LINK] ${mdFile.path} → ${targetPath}`;
          logLines.push(msg);
        }
      }
    }

    new PreviewModal(this.app, preview, async () => this.confirmMoves(logLines)).open();
    await this.appendLog(logLines);
  }

  // =====================
  // Confirm & execute moves
  // =====================
  async confirmMoves(logLines: string[]) {
    if (this.settings.dryRun) {
      new Notice("Dry-run enabled: no files moved.");
      return;
    }

    const vault = this.app.vault;
    for (const line of logLines) {
      const match = line.match(/→ (.+) \|/);
      const srcMatch = line.match(/^.*?\s→\s(.+?)\s\|/);
      if (!match || !srcMatch) continue;

      const dstPath = normalizePath(match[1]);
      const srcPath = normalizePath(srcMatch[1]);

      const folder = dstPath.substring(0, dstPath.lastIndexOf("/"));
      if (!(await vault.adapter.exists(folder))) {
        await vault.createFolder(folder).catch(() => {});
      }

      const file = vault.getAbstractFileByPath(srcPath) as TFile;
      if (file) {
        await vault.rename(file, dstPath).catch(err => {
          console.error(`Failed to move ${srcPath} → ${dstPath}`, err);
        });
      }
    }

    await this.appendLog(logLines);
    new Notice("Image & Audio Organizer: files moved and logged.");
  }

  // =====================
  // Append to log
  // =====================
  async appendLog(logLines: string[]) {
    const vault = this.app.vault;
    const logFolderPath = "logs";
    const logFilePath = `${logFolderPath}/image-organizer-log.md`;

    if (!(await vault.adapter.exists(logFolderPath))) {
      await vault.createFolder(logFolderPath).catch(() => {});
    }

    const existing = vault.getAbstractFileByPath(logFilePath);
    const content = logLines.join("\n") + "\n";

    if (existing && existing instanceof TFile) {
      const old = await vault.read(existing);
      await vault.modify(existing, old + content);
    } else {
      await vault.create(logFilePath, content);
    }
  }

  maskName(filePath: string): string {
    return this.settings.maskSensitive ? "*****" : filePath;
  }
}

// =====================
// Preview Modal
// =====================
class PreviewModal extends Modal {
  previewLines: string[];
  onConfirm: () => void;

  constructor(app: App, previewLines: string[], onConfirm: () => void) {
    super(app);
    this.previewLines = previewLines;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Image & Audio Organizer Preview" });

    const pre = contentEl.createEl("pre");
    pre.textContent = this.previewLines.join("\n");

    const container = contentEl.createDiv({ cls: "modal-button-container" });

    container.createEl("button", { text: "Apply Changes" }).onclick = () => {
      this.close();
      this.onConfirm();
    };
    container.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// =====================
// Date Conflict Modal
// =====================
class DateConflictModal extends Modal {
  fileName: string;
  filePath: string;
  created: Date;
  modified: Date;
  onChoose: (chosen: Date | null) => Promise<void>;
  plugin: ImageOrganizerPlugin;

  constructor(app: App, plugin: ImageOrganizerPlugin, fileName: string, filePath: string, created: Date, modified: Date, onChoose: (chosen: Date | null) => Promise<void>) {
    super(app);
    this.fileName = fileName;
    this.filePath = filePath;
    this.created = created;
    this.modified = modified;
    this.onChoose = onChoose;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;

    if (this.plugin.leaveAllInPlace) {
      this.onChoose(null);
      this.close();
      return;
    }

    contentEl.createEl("h3", { text: "Date Conflict Detected" });
    contentEl.createEl("p", { text: `File: ${this.fileName}` });
    contentEl.createEl("p", { text: `Path: ${this.filePath}` });
    contentEl.createEl("p", { text: `Created: ${this.created.toLocaleString()}` });
    contentEl.createEl("p", { text: `Modified: ${this.modified.toLocaleString()}` });
    contentEl.createEl("p", { text: "Which date should be used for organizing?" });

    const container = contentEl.createDiv({ cls: "modal-button-container" });

    container.createEl("button", { text: "Use Created Date" }).onclick = async () => {
      await this.onChoose(this.created);
      this.close();
    };
    container.createEl("button", { text: "Use Modified Date" }).onclick = async () => {
      await this.onChoose(this.modified);
      this.close();
    };
    container.createEl("button", { text: "Leave in Place" }).onclick = async () => {
      await this.onChoose(null);
      this.close();
    };
    container.createEl("button", { text: "Leave All in Place" }).onclick = async () => {
      this.plugin.leaveAllInPlace = true;
      await this.onChoose(null);
      this.close();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

// =====================
// Settings Tab
// =====================
class OrganizerSettingTab extends PluginSettingTab {
  plugin: ImageOrganizerPlugin;

  constructor(app: App, plugin: ImageOrganizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "Image & Audio Organizer Settings" });

    new Setting(containerEl)
      .setName("Dry-run mode")
      .setDesc("When enabled, files are never moved (preview only). Logs are still recorded.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.dryRun)
          .onChange(async value => {
            this.plugin.settings.dryRun = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Mask sensitive file names")
      .setDesc("If enabled, filenames will be starred out in logs (private).")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.maskSensitive)
          .onChange(async value => {
            this.plugin.settings.maskSensitive = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
