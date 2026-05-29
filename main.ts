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

    const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "heic"];
    const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "flac", "aac", "ogg"];
    const VIDEO_EXTENSIONS = ["mp4"];

    const SUPPORTED_EXTENSIONS = [
      ...IMAGE_EXTENSIONS,
      ...AUDIO_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
    ];

    const locationTxtPath = "location.txt";
    const locationMap: Record<string, string> = {};

    // ------------------------------------------------
    // LOAD LOCATION MAP
    // ------------------------------------------------
    if (await vault.adapter.exists(locationTxtPath)) {
      const content = await vault.adapter.read(locationTxtPath);

      const lines = content
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith("#"));

      for (const line of lines) {
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
      const key = mdFile.name.toLowerCase();
      const targetFolder = locationMap[key];

      if (!targetFolder) continue;

      await this.ensureFolderExists(targetFolder);

      // ------------------------------------------------
      // MOVE MARKDOWN FILE ITSELF
      // ------------------------------------------------
      const mdTargetPath = normalizePath(
        `${targetFolder}/${mdFile.name}`
      );

      preview.push(
        `[MD MOVE] ${this.maskName(mdFile.path)} → ${mdTargetPath}`
      );
      logLines.push(
        `[MD MOVE] ${mdFile.path} → ${mdTargetPath}`
      );

      if (!this.settings.dryRun) {
        await vault.rename(mdFile, mdTargetPath).catch((err) => {
          console.error("Failed moving MD:", err);
        });
      }

      // ------------------------------------------------
      // MOVE LINKED MEDIA
      // ------------------------------------------------
      const cache = metadataCache.getFileCache(mdFile);
      if (!cache?.links) continue;

      for (const linkObj of cache.links) {
        const linkedPath = normalizePath(linkObj.link);

        const mediaFile =
          vault.getAbstractFileByPath(linkedPath) as TFile;

        if (!mediaFile) {
          const msg = `[BROKEN LINK] ${mdFile.path} → ${linkedPath}`;
          preview.push(msg);
          logLines.push(msg);
          continue;
        }

        const ext = mediaFile.extension.toLowerCase();

        if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;

        const dstPath = normalizePath(
          `${targetFolder}/${mediaFile.name}`
        );

        if (mediaFile.path === dstPath) continue;

        const msg = `[MEDIA MOVE] ${this.maskName(
          mediaFile.path
        )} → ${dstPath}`;

        preview.push(msg);
        logLines.push(msg);

        if (!this.settings.dryRun && !this.settings.leaveAllInPlace) {
          await vault.rename(mediaFile, dstPath).catch((err) => {
            console.error(
              `Failed moving media ${mediaFile.path}`,
              err
            );
          });
        }
      }
    }

    // ------------------------------------------------
    // BROKEN LINK SCAN (global safety pass)
    // ------------------------------------------------
    for (const mdFile of files.filter((f) => f.extension === "md")) {
      const cache = metadataCache.getFileCache(mdFile);
      if (!cache?.links) continue;

      for (const link of cache.links) {
        const target = normalizePath(link.link);
        const exists = vault.getAbstractFileByPath(target);

        if (!exists) {
          logLines.push(
            `[BROKEN LINK] ${mdFile.path} → ${target}`
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
    // PREVIEW
    // ------------------------------------------------
    new PreviewModal(
      this.app,
      preview,
      () => new Notice("Organizer complete")
    ).open();
  }

  // ------------------------------------------------
  // CREATE FOLDERS RECURSIVELY
  // ------------------------------------------------
  async ensureFolderExists(folderPath: string) {
    const parts = normalizePath(folderPath).split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      try {
        if (!(await this.app.vault.adapter.exists(current))) {
          await this.app.vault.createFolder(current);
        }
      } catch (_) {}
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
