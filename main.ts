import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, normalizePath, Notice } from "obsidian";

// =====================
// Settings
// =====================
interface OrganizerSettings {
  dryRun: boolean;
}

const DEFAULT_SETTINGS: OrganizerSettings = {
  dryRun: true,
};

// =====================
// Main Plugin
// =====================
export default class ImageOrganizerPlugin extends Plugin {
  settings: OrganizerSettings;

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
    const preview: string[] = [];
    const logLines: string[] = [];

    const months: Record<string, string> = {
      "01": "January",
      "02": "February",
      "03": "March",
      "04": "April",
      "05": "May",
      "06": "June",
      "07": "July",
      "08": "August",
      "09": "September",
      "10": "October",
      "11": "November",
      "12": "December",
    };

    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic"];
    const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac", "aac"];

    for (const file of files) {
      const ext = file.extension.toLowerCase();

      if (![...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS].includes(ext)) {
        const msg = `[SKIP] Unsupported type: ${file.path}`;
        preview.push(msg);
        logLines.push(msg);
        continue;
      }

      let year: string | null = null;
      let month: string | null = null;
      let day: string | null = null;

      // Parse filename for date
      const matchNumeric = file.name.match(/(\d{4})(\d{2})(\d{2})/);
      const matchMac = file.name.match(/(\d{4})-(\d{2})-(\d{2})/);

      if (matchNumeric) [year, month, day] = matchNumeric.slice(1, 4);
      else if (matchMac) [year, month, day] = matchMac.slice(1, 4);

      // Audio fallback to file stats
      if ((!year || !month || !day) && AUDIO_EXTENSIONS.includes(ext)) {
        const stats = await vault.adapter.stat(file.path);
        const created = new Date(stats.birthtime);
        const modified = new Date(stats.mtime);

        if (created.toDateString() !== modified.toDateString()) {
          await new DateConflictModal(this.app, file.path, created, modified, async (chosen: Date | null) => {
            if (chosen) {
              year = String(chosen.getFullYear());
              month = String(chosen.getMonth() + 1).padStart(2, "0");
              day = String(chosen.getDate()).padStart(2, "0");
            }
          }).open();
        } else {
          const chosen = created;
          year = String(chosen.getFullYear());
          month = String(chosen.getMonth() + 1).padStart(2, "0");
          day = String(chosen.getDate()).padStart(2, "0");
        }
      }

      if (!year || !month || !day) {
        const msg = `[SKIP] No valid date: ${file.path}`;
        preview.push(msg);
        logLines.push(msg);
        continue;
      }

      const monthName = months[month] ?? "Unknown";
      if (monthName === "Unknown") {
        const msg = `[SKIP] Unknown month: ${file.path}`;
        preview.push(msg);
        logLines.push(msg);
        continue;
      }

      // Determine target path
      let targetPath: string;
      if (file.path.toLowerCase().includes("gamereview.md")) {
        targetPath = normalizePath(`${year}/Other/Game/${file.name}`);
      } else {
        targetPath = normalizePath(`${year}/${monthName}/${year}-${month}-${day}/${file.name}`);
      }

      const dryTag = this.settings.dryRun ? "[DRY RUN] " : "";
      preview.push(`${dryTag}${file.path} → ${targetPath}`);
      logLines.push(`${dryTag}${new Date().toISOString()} | ${file.path} → ${targetPath}`);
    }

    // Show preview modal first
    new PreviewModal(this.app, preview, async () => this.confirmMoves(logLines)).open();

    // Log dry-run moves immediately
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
      const match = line.match(/→ (.+)$/);
      const srcMatch = line.match(/\| (.+) →/);
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

    // Append executed moves to log
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

    // Create the logs folder if it doesn't exist
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
  filePath: string;
  created: Date;
  modified: Date;
  onChoose: (chosen: Date | null) => Promise<void>;

  constructor(app: App, filePath: string, created: Date, modified: Date, onChoose: (chosen: Date | null) => Promise<void>) {
    super(app);
    this.filePath = filePath;
    this.created = created;
    this.modified = modified;
    this.onChoose = onChoose;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Date Conflict Detected" });
    contentEl.createEl("p", { text: `File: ${this.filePath}` });
    contentEl.createEl("p", { text: `Created: ${this.created.toDateString()}, Modified: ${this.modified.toDateString()}` });
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
  }
}
