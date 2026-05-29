import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, normalizePath, Notice } from "obsidian";

interface OrganizerSettings {
  dryRun: boolean;
  maskSensitive: boolean;
  leaveAllInPlace: boolean;
}

const DEFAULT_SETTINGS: OrganizerSettings = {
  dryRun: true,
  maskSensitive: false,
  leaveAllInPlace: false,
};

export default class ImageOrganizerPlugin extends Plugin {
  settings: OrganizerSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new OrganizerSettingTab(this.app, this));
    this.addCommand({
      id: "run-image-organizer",
      name: "Run Organizer",
      callback: () => this.runOrganizer(),
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async runOrganizer() {
    const vault = this.app.vault;
    const files = vault.getFiles();
    const logLines: string[] = [];
    const preview: string[] = [];

    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic"];
    const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac", "aac", "ogg"];
    const VIDEO_EXTENSIONS = ["mp4"];
    const SUPPORTED_EXTENSIONS = [...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];

    const locationTxtPath = "location.txt";
    const locationMap: Record<string, string> = {};

    // ---------------------
    // Load location.txt
    // Format:  Filename.ext -> destination/folder
    // Example: Q2.MD       -> Notes/2024/Other/PQ2s
    // Lines starting with # are comments.
    // ---------------------
    if (await vault.adapter.exists(locationTxtPath)) {
      const content = await vault.adapter.read(locationTxtPath);
      const lines = content.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("#"));
      for (const line of lines) {
        const match = line.match(/^(.+?)\s*->\s*(.+)$/);
        if (match) {
          const filename = match[1].trim();
          const folder = match[2].trim();
          if (filename && folder) locationMap[filename.toLowerCase()] = folder;
        }
      }
    } else {
      new Notice("location.txt not found in vault root");
      return;
    }

    const metadataCache = this.app.metadataCache;

    // ---------------------
    // Process markdown files for linked media
    // ---------------------
    for (const mdFile of files.filter(f => f.extension === "md")) {
      const matchedFolder = locationMap[mdFile.name.toLowerCase()];
      if (!matchedFolder) continue;
      const targetFolder = normalizePath(matchedFolder);
      if (!this.settings.dryRun) await vault.createFolder(targetFolder).catch(() => {});

      const cache = metadataCache.getFileCache(mdFile);
      if (!cache?.links) continue;

      for (const linkObj of cache.links) {
        const linked = normalizePath(linkObj.link);
        const ext = linked.split(".").pop()?.toLowerCase();
        if (!ext || !SUPPORTED_EXTENSIONS.includes(ext)) continue;

        const mediaFile = vault.getAbstractFileByPath(linked) as TFile;
        if (!mediaFile) {
          const msg = `[BROKEN LINK] ${mdFile.path} → ${linked}`;
          preview.push(msg); logLines.push(msg);
          continue;
        }

        // Check creation vs modification dates for audio
        if (AUDIO_EXTENSIONS.includes(ext)) {
          const created = mediaFile.stat.ctime;
          const modified = mediaFile.stat.mtime;
          if (created !== modified && !this.settings.leaveAllInPlace) {
            const msg = `[DATE MISMATCH] ${mediaFile.name} | created: ${new Date(created).toISOString()} modified: ${new Date(modified).toISOString()}`;
            preview.push(msg); logLines.push(msg);
          }
        }

        const dstPath = normalizePath(`${targetFolder}/${mediaFile.name}`);
        const msg = `[MD MEDIA MOVE] ${this.maskName(mdFile.path)} → ${dstPath}`;
        preview.push(msg); logLines.push(msg);

        if (!this.settings.dryRun && !this.settings.leaveAllInPlace) {
          await vault.rename(mediaFile, dstPath).catch(err => {
            console.error(`Failed to move ${mediaFile.path} → ${dstPath}`, err);
          });
        }
      }

      preview.push(`Check location.txt for media from ${mdFile.name}`);
      logLines.push(`Check location.txt for media from ${mdFile.name}`);
    }

    // ---------------------
    // Date-based organization for remaining files (skipped if MD)
    // ---------------------
    for (const file of files) {
      const ext = file.extension.toLowerCase();
      if (ext === "md") continue;

      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        const msg = `[SKIP] Unsupported type: ${this.maskName(file.path)}`;
        preview.push(msg); logLines.push(msg);
        continue;
      }

      // You can add your date-based organization logic here
    }

    // ---------------------
    // Detect broken links in all MD
    // ---------------------
    for (const mdFile of files.filter(f => f.extension === "md")) {
      const cache = metadataCache.getFileCache(mdFile);
      if (!cache?.links) continue;
      for (const link of cache.links) {
        const target = normalizePath(link.link);
        const targetFile = vault.getAbstractFileByPath(target);
        if (!targetFile) logLines.push(`[BROKEN LINK] ${mdFile.path} → ${target}`);
      }
    }

    // ---------------------
    // Write logs
    // ---------------------
    const logFileName = `logs/image-organizer-log-${this.timestamp()}.md`;
    await this.appendLog(logLines, logFileName);

    // ---------------------
    // Preview modal
    // ---------------------
    new PreviewModal(this.app, preview, () => new Notice("Organizer preview complete.")).open();
  }

  async appendLog(logLines: string[], path: string) {
    const vault = this.app.vault;
    const existingContent = (await vault.adapter.exists(path)) ? await vault.adapter.read(path) : "";
    await vault.adapter.write(path, existingContent + logLines.join("\n") + "\n");
  }

  maskName(filePath: string): string {
    return this.settings.maskSensitive ? "*****" : filePath;
  }

  timestamp(): string {
    const d = new Date();
    return d.getFullYear().toString() +
           ("0"+(d.getMonth()+1)).slice(-2) +
           ("0"+d.getDate()).slice(-2) +
           ("0"+d.getHours()).slice(-2) +
           ("0"+d.getMinutes()).slice(-2) +
           ("0"+d.getSeconds()).slice(-2);
  }
}

// ---------------------
// Preview Modal
// ---------------------
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
    contentEl.createEl("h2", { text: "Organizer Preview" });
    const pre = contentEl.createEl("pre");
    pre.textContent = this.previewLines.join("\n");
    const container = contentEl.createDiv({ cls: "modal-button-container" });
    container.createEl("button", { text: "Close All (Leave in place)" }).onclick = () => {
    const plugin = this.app.plugins.getPlugin("image-organizer");
if (plugin) {
    plugin.settings.leaveAllInPlace = true;
}
      this.close();
    };
    container.createEl("button", { text: "Close" }).onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

// ---------------------
// Settings Tab
// ---------------------
class OrganizerSettingTab extends PluginSettingTab {
  plugin: ImageOrganizerPlugin;
  constructor(app: App, plugin: ImageOrganizerPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h3", { text: "Organizer Settings" });

    new Setting(containerEl)
      .setName("Dry-run mode")
      .setDesc("Files are never moved; preview only. Logs are still recorded.")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.dryRun)
          .onChange(async value => { this.plugin.settings.dryRun = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Mask sensitive filenames")
      .setDesc("Star out filenames in logs for privacy.")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.maskSensitive)
          .onChange(async value => { this.plugin.settings.maskSensitive = value; await this.plugin.saveSettings(); })
      );

    new Setting(containerEl)
      .setName("Leave all files in place for date conflicts")
      .setDesc("Automatically skip moving files when creation/modification mismatch detected.")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.leaveAllInPlace)
          .onChange(async value => { this.plugin.settings.leaveAllInPlace = value; await this.plugin.saveSettings(); })
      );
  }
}
