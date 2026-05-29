import {
  App,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  Notice,
} from "obsidian";

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

  // ------------------------------------------------
  // MAIN RUN
  // ------------------------------------------------
  async runOrganizer() {
    const vault = this.app.vault;
    const files = vault.getFiles();

    const logLines: string[] = [];
    const preview: string[] = [];

    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic", "webp", "gif"];
    const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac", "aac", "ogg"];
    const VIDEO_EXTENSIONS = ["mp4", "mov", "webm"];

    const locationTxtPath = "location.txt";
    const locationMap: Record<string, string> = {};

    // ------------------------------------------------
    // LOAD LOCATION MAP
    // ------------------------------------------------
    if (await vault.adapter.exists(locationTxtPath)) {
      const content = await vault.adapter.read(locationTxtPath);

      for (const line of content.split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith("#")) continue;

        const match = line.match(/^(.+?)\s*->\s*(.+)$/);
        if (!match) continue;

        const filename = match[1].trim().toLowerCase();
        const folder = normalizePath(match[2].trim());

        locationMap[filename] = folder;
      }
    } else {
      new Notice("location.txt not found in vault root");
      return;
    }

    const metadataCache = this.app.metadataCache;

    // ------------------------------------------------
    // PROCESS MARKDOWN FILES
    // ------------------------------------------------
    for (const mdFile of files.filter((f) => f.extension === "md")) {
      const targetFolder = locationMap[mdFile.name.toLowerCase()];
      if (!targetFolder) continue;

      await this.ensureFolderExists(targetFolder);

      const mdCache = metadataCache.getFileCache(mdFile);
      if (!mdCache) continue;

      const allRefs = [
        ...(mdCache.links ?? []),
        ...(mdCache.embeds ?? []),
      ];

      // ------------------------------------------------
      // MOVE MEDIA FIRST (IMPORTANT)
      // ------------------------------------------------
      for (const ref of allRefs) {
        const raw = ref.link.split("|")[0];

        const mediaFile = metadataCache.getFirstLinkpathDest(
          raw,
          mdFile.path
        ) as TFile;

        if (!mediaFile) continue;

        const ext = mediaFile.extension.toLowerCase();

        let subfolder = "Other";

        if (IMAGE_EXTENSIONS.includes(ext)) subfolder = "Images";
        else if (AUDIO_EXTENSIONS.includes(ext)) subfolder = "Audio";
        else if (VIDEO_EXTENSIONS.includes(ext)) subfolder = "Video";

        const finalFolder = normalizePath(
          `${targetFolder}/${subfolder}`
        );

        await this.ensureFolderExists(finalFolder);

        const dstPath = normalizePath(
          `${finalFolder}/${mediaFile.name}`
        );

        if (mediaFile.path === dstPath) continue;

        const msg = `[MEDIA MOVE] ${mediaFile.path} → ${dstPath}`;
        preview.push(msg);
        logLines.push(msg);

        if (!this.settings.dryRun && !this.settings.leaveAllInPlace) {
          await vault.rename(mediaFile, dstPath).catch(console.error);
        }
      }

      // ------------------------------------------------
      // MOVE MARKDOWN FILE
      // ------------------------------------------------
      const mdTargetPath = normalizePath(
        `${targetFolder}/${mdFile.name}`
      );

      preview.push(`[MD MOVE] ${mdFile.path} → ${mdTargetPath}`);
      logLines.push(`[MD MOVE] ${mdFile.path} → ${mdTargetPath}`);

      if (!this.settings.dryRun) {
        await vault.rename(mdFile, mdTargetPath).catch(console.error);
      }
    }

    // ------------------------------------------------
    // BROKEN LINK CHECK
    // ------------------------------------------------
    for (const mdFile of files.filter((f) => f.extension === "md")) {
      const mdCache = metadataCache.getFileCache(mdFile);
      if (!mdCache) continue;

      for (const ref of [
        ...(mdCache.links ?? []),
        ...(mdCache.embeds ?? []),
      ]) {
        const target = metadataCache.getFirstLinkpathDest(
          ref.link.split("|")[0],
          mdFile.path
        );

        if (!target) {
          logLines.push(
            `[BROKEN LINK] ${mdFile.path} → ${ref.link}`
          );
        }
      }
    }

    // ------------------------------------------------
    // WRITE LOG
    // ------------------------------------------------
    const logFileName = `logs/image-organizer-log-${this.timestamp()}.md`;

    await this.appendLog(logLines, logFileName);

    // ------------------------------------------------
    // PREVIEW MODAL
    // ------------------------------------------------
    new PreviewModal(
      this.app,
      preview,
      () => new Notice("Organizer complete")
    ).open();
  }

  // ------------------------------------------------
  // SAFE FOLDER CREATION (FIX INCLUDED)
  // ------------------------------------------------
  async ensureFolderExists(folderPath: string) {
    const vault = this.app.vault;

    const normalized = normalizePath(folderPath);
    const parts = normalized.split("/");

    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      try {
        const exists = await vault.adapter.exists(current);

        if (!exists) {
          await vault.createFolder(current);
        }
      } catch (_) {
        // ignore race conditions / existing folder errors
      }
    }
  }

  // ------------------------------------------------
  // LOGGING
  // ------------------------------------------------
  async appendLog(logLines: string[], path: string) {
    const vault = this.app.vault;

    const exists = await vault.adapter.exists(path);

    const old = exists ? await vault.adapter.read(path) : "";

    await vault.adapter.write(
      path,
      old + logLines.join("\n") + "\n"
    );
  }

  maskName(filePath: string): string {
    return this.settings.maskSensitive ? "*****" : filePath;
  }

  timestamp(): string {
    const d = new Date();
    return (
      d.getFullYear().toString() +
      ("0" + (d.getMonth() + 1)).slice(-2) +
      ("0" + d.getDate()).slice(-2) +
      ("0" + d.getHours()).slice(-2) +
      ("0" + d.getMinutes()).slice(-2) +
      ("0" + d.getSeconds()).slice(-2)
    );
  }
}

// ------------------------------------------------
// PREVIEW MODAL
// ------------------------------------------------
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

    contentEl.createEl("h2", {
      text: "Organizer Preview",
    });

    const pre = contentEl.createEl("pre");
    pre.textContent = this.previewLines.join("\n");

    const container = contentEl.createDiv({
      cls: "modal-button-container",
    });

    container.createEl("button", {
      text: "Close (Leave in place)",
    }).onclick = () => {
      const plugin =
        this.app.plugins.getPlugin("image-organizer");

      if (plugin) {
        plugin.settings.leaveAllInPlace = true;
      }

      this.close();
    };

    container.createEl("button", {
      text: "Close",
    }).onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ------------------------------------------------
// SETTINGS TAB
// ------------------------------------------------
class OrganizerSettingTab extends PluginSettingTab {
  plugin: ImageOrganizerPlugin;

  constructor(app: App, plugin: ImageOrganizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", {
      text: "Organizer Settings",
    });

    new Setting(containerEl)
      .setName("Dry-run mode")
      .setDesc("Preview only; no files are moved.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.dryRun)
          .onChange(async (value) => {
            this.plugin.settings.dryRun = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Mask filenames")
      .setDesc("Hide filenames in logs.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.maskSensitive)
          .onChange(async (value) => {
            this.plugin.settings.maskSensitive = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Skip moves on conflicts")
      .setDesc("Do not move files when flagged.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.leaveAllInPlace)
          .onChange(async (value) => {
            this.plugin.settings.leaveAllInPlace = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
