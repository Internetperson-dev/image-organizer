import { App, Modal, Plugin, PluginSettingTab, Setting, TFile, normalizePath, Notice } from "obsidian";

interface OrganizerSettings {
  dryRun: boolean;
  maskSensitive: boolean;
}

const DEFAULT_SETTINGS: OrganizerSettings = {
  dryRun: true,
  maskSensitive: false,
};

export default class ImageOrganizerPlugin extends Plugin {
  settings: OrganizerSettings;
  leaveAllInPlace: boolean = false;

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

    const mediaTxtPath = "media.txt"; // vault root
    const mediaMap: Record<string, string> = {};

    // ---------------------
    // Load existing media.txt
    // ---------------------
    if (await vault.adapter.exists(mediaTxtPath)) {
      const content = await vault.adapter.read(mediaTxtPath);
      const lines = content.split(/\r?\n/).filter(l => l.trim());
      for (let i = 0; i < lines.length; i += 2) {
        const md = lines[i];
        const folder = lines[i + 1];
        if (md && folder) mediaMap[md] = folder;
      }
    }

    const metadataCache = this.app.metadataCache;

    // ---------------------
    // Parse markdown for linked media
    // ---------------------
    for (const mdFile of files.filter(f => f.extension === "md")) {
      const cache = metadataCache.getFileCache(mdFile);
      if (!cache?.links) continue;

      const links = cache.links.map(l => normalizePath(l.link));
      const mediaLinks = links.filter(l => {
        const ext = l.split(".").pop()?.toLowerCase();
        return SUPPORTED_EXTENSIONS.includes(ext ?? "");
      });
      if (mediaLinks.length === 0) continue;

      const mdFolder = mdFile.parent.path;
      const targetFolder = normalizePath(`${mdFolder}/${mdFile.basename} Media`);
      mediaMap[mdFile.path] = targetFolder;

      if (!this.settings.dryRun) await vault.createFolder(targetFolder).catch(() => {});

      for (const mediaPath of mediaLinks) {
        const mediaFile = vault.getAbstractFileByPath(mediaPath) as TFile;
        if (!mediaFile) continue;

        const dstPath = `${targetFolder}/${mediaFile.name}`;
        const logMsg = `[MD MEDIA MOVE] ${this.maskName(mdFile.path)} → ${dstPath}`;
        preview.push(logMsg);
        logLines.push(logMsg);

        if (!this.settings.dryRun) {
          await vault.rename(mediaFile, dstPath).catch(err => {
            console.error(`Failed to move ${mediaFile.path} → ${dstPath}`, err);
          });
        }
      }

      preview.push(`Check media.txt for MD-linked media from ${mdFile.path}`);
      logLines.push(`Check media.txt for MD-linked media from ${mdFile.path}`);
    }

    // ---------------------
    // Date-based organization for remaining files
    // ---------------------
    for (const file of files) {
      const ext = file.extension.toLowerCase();
      if (ext === "md") continue;

      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        const msg = `[SKIP] Unsupported type: ${this.maskName(file.path)}`;
        preview.push(msg); logLines.push(msg);
        continue;
      }

      // Implement your existing date-based organization here
      // Fallback to folder-date from filename or metadata
    }

    // ---------------------
    // Broken link detection
    // ---------------------
    const mdFiles = files.filter(f => f.extension === "md");
    for (const mdFile of mdFiles) {
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
    await this.appendLog(logLines, "logs/image-organizer-log-" + this.timestamp() + ".md");

    // ---------------------
    // Write media.txt
    // ---------------------
    let mediaTxtContent = "";
    for (const [md, folder] of Object.entries(mediaMap)) {
      mediaTxtContent += `${md}\n${folder}\n`;
    }
    await vault.adapter.write(mediaTxtPath, mediaTxtContent);

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
  }
}
