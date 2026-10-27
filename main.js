"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Plugin, Notice, Menu, ItemView, TFile, TFolder, FuzzySuggestModal, Modal, TextComponent, DropdownComponent, FileSystemAdapter, PluginSettingTab, Setting, setIcon, normalizePath } = require("obsidian");

// PDF++ 用来把笔记和 PDF 绑起来的属性，取它自己的设置，没有就用默认值
const DEFAULT_PROP = "PDF";
const MATERIAL = "材料";
const NOTES = "产出";
const STUDY = "笔记";
const NOTE_PROP = "笔记";
const MATERIAL_PROP = "材料";
const WORK = "作业";

// 和 Excalidraw 插件自己新建画布时的 parsed 空白场景保持一致
const EXCALIDRAW_SKELETON = [
  "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
  "",
  "# Excalidraw Data",
  "",
  "## Text Elements",
  "%%",
  "# Drawing",
  "```json",
  '\t{"type":"excalidraw","version":2,"source":"https://github.com/zsviczian/obsidian-excalidraw-plugin/releases","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"}}',
  "```",
  "%%",
  "",
].join("\n");
const CODE_EXT = new Set(["py", "ipynb", "js", "mjs", "ts", "sh", "c", "cc", "cpp", "cxx", "h", "hpp", "java", "rs", "go", "r", "m", "sql"]);
const IS_WIN = process.platform === "win32";
const DEFAULT_EDITOR = IS_WIN ? 'code "{path}"' : 'open -a "Visual Studio Code" "{path}"';

function splitList(raw) {
  return String(raw || "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// Windows 上不走 shell：code.cmd 经 cmd 传中文路径会乱码，直接找 Code.exe
const VSCODE_CANDIDATES = [
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
  process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
  process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft VS Code", "Code.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "VSCodium", "VSCodium.exe"),
].filter(Boolean);

// Visual Studio（IDE，不是 Code）：按版本目录倒序找 devenv.exe，18 / 2022 / 2019 都认
function findDevenv() {
  const roots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft Visual Studio"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Microsoft Visual Studio"),
  ].filter(Boolean);
  for (const root of roots) {
    let versions = [];
    try {
      versions = fs.readdirSync(root);
    } catch (error) {
      continue;
    }
    for (const version of versions.sort().reverse()) {
      let editions = [];
      try {
        editions = fs.readdirSync(path.join(root, version));
      } catch (error) {
        continue;
      }
      for (const edition of editions) {
        const exe = path.join(root, version, edition, "Common7", "IDE", "devenv.exe");
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return null;
}

const SOLUTION_EXT = new Set(["sln", "slnx"]);
const VS_OPENABLE_EXT = new Set(["sln", "slnx", "vcxproj", "csproj"]);
const DEFAULT_RUNS = [
  'py: python3 "{file}"',
  'js: node "{file}"',
  'sh: bash "{file}"',
  'cpp: g++ "{file}" -o "{base}" && "./{base}"',
  'c: cc "{file}" -o "{base}" && "./{base}"',
  'java: javac "{file}" && java "{base}"',
].join("\n");

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
const LECTURE = "课件";

function isNote(file) {
  const name = file.name.toLowerCase();
  return name.endsWith(".md") || name.endsWith(".canvas");
}

// Drawing.excalidraw.md 这种也要能跟 Drawing.pdf 对上
function noteTitle(file) {
  return file.name.replace(/\.excalidraw\.md$/i, "").replace(/\.(md|canvas)$/i, "");
}

function linkTarget(link) {
  let target = link;
  const pipe = target.indexOf("|");
  if (pipe >= 0) target = target.slice(0, pipe);
  const hash = target.indexOf("#");
  if (hash >= 0) target = target.slice(0, hash);
  return target.trim();
}

function isWorkFile(file) {
  return file.path.includes(`/${WORK}/`);
}

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 让作业记录挂到对应的那一讲课件上
class LectureSuggest extends FuzzySuggestModal {
  constructor(app, items, onChoose) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.setPlaceholder("这篇作业对应哪份课件");
  }

  getItems() {
    return this.items;
  }

  getItemText(item) {
    return item.basename;
  }

  onChooseItem(item) {
    this.onChoose(item);
  }
}

const VIEW_TYPE = "material-group-view";
const PROGRESS_VIEW = "material-progress-view";

// 右侧面板：跟着当前文件，把同一组里的课件、实验、笔记、作业列出来
class GroupView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "本组";
  }

  getIcon() {
    return "lucide-layers";
  }

  async onOpen() {
    this.refresh();
  }

  async onClose() {}

  refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("mn-group");

    const file = this.app.workspace.getActiveFile();
    const group = file ? this.plugin.buildGroup(file) : null;

    if (!group) {
      container.createEl("p", { text: "当前文件不属于某一组材料", cls: "mn-empty" });
      return;
    }

    if (group.lecture) container.createEl("div", { text: group.lecture.basename, cls: "mn-title" });

    for (const section of group.sections) {
      const box = container.createDiv({ cls: "mn-section" });
      box.createEl("div", { text: section.label, cls: "mn-label" });
      for (const item of section.files) {
        const target = this.plugin.mediaTarget(item);
        const row = box.createDiv({ cls: "mn-row" });
        if (file && target.path === file.path) row.addClass("is-current");
        const icon = row.createSpan({ cls: "mn-icon" });
        setIcon(icon, this.iconFor(target));
        row.createSpan({ text: item.basename, cls: "mn-name" });

        // 这门课的游标正好停在这个文件上，行里挂个页码徽标
        const entry = this.plugin.progressEntryFor(target);
        if (entry) row.createSpan({ text: entry.page ? `P${entry.page}` : "进度", cls: "mn-badge" });

        const meta = this.plugin.mediaDuration(item) || (item.parent?.name !== target.parent?.name ? item.parent?.name : "");
        if (meta) row.createSpan({ text: meta, cls: "mn-where" });

        row.onclick = () => {
          const ext = target.extension.toLowerCase();
          if (ext === "md" || ext === "canvas") this.plugin.openFile(target);
          else this.plugin.openMaterial(target);
        };
      }
    }
  }

  iconFor(file) {
    const ext = file.extension.toLowerCase();
    if (["mp4", "mkv", "mov", "avi", "webm", "m4v"].includes(ext)) return "lucide-video";
    if (["mp3", "m4a", "wav", "flac", "ogg"].includes(ext)) return "lucide-audio-lines";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "lucide-image";
    if (["epub", "mobi", "azw3"].includes(ext)) return "lucide-book-open";
    if (["html", "htm"].includes(ext)) return "lucide-globe";
    if (file.name.toLowerCase().endsWith(".excalidraw.md")) return "lucide-pencil-ruler";
    if (ext === "md") return "lucide-file-text";
    if (ext === "canvas") return "lucide-layout-dashboard";
    if (ext === "pdf") return "lucide-file-type-2";
    if (ext === "docx" || ext === "doc") return "lucide-file-text";
    if (ext === "pptx" || ext === "ppt") return "lucide-presentation";
    if (CODE_EXT.has(ext)) return "lucide-file-code";
    return "lucide-paperclip";
  }
}

class TextPromptModal extends Modal {
  constructor(app, heading, placeholder, onSubmit) {
    super(app);
    this.heading = heading;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.heading });
    const input = new TextComponent(contentEl);
    input.setPlaceholder(this.placeholder);
    input.inputEl.style.width = "100%";
    input.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const value = input.getValue().trim();
        if (!value) return;
        this.close();
        this.onSubmit(value);
      }
    });
    window.setTimeout(() => input.inputEl.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MaterialSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("本组分段顺序")
      .setDesc(
        "「本组」面板按文件所在目录自动分段（库里有什么目录就只显示哪几段），这里控制段的先后。逗号分隔，没列到的排在后面。"
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.slotOrder).onChange(async (value) => {
          this.plugin.settings.slotOrder = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("实验目录名")
      .setDesc("材料下这些子目录里的文件按「实验」处理（影响组的构建方向）。逗号分隔。")
      .addText((text) =>
        text.setValue(this.plugin.settings.labFolders).onChange(async (value) => {
          this.plugin.settings.labFolders = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("实验文件名关键词")
      .setDesc("材料目录下文件名命中这些词的也判为实验。正则片段，逗号分隔，留空则只按目录判。")
      .addText((text) =>
        text.setValue(this.plugin.settings.labKeywords).onChange(async (value) => {
          this.plugin.settings.labKeywords = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("荣耀分享落地目录")
      .setDesc("平板用荣耀分享传文件后的落地点。插件会盯着这个目录，新文件落稳后自动按路由表归档。")
      .addText((text) =>
        text.setValue(this.plugin.settings.shareInboxDir).onChange(async (value) => {
          this.plugin.settings.shareInboxDir = value.trim();
          await this.plugin.saveSettings();
          this.plugin.restartShareWatcher();
        })
      );

    new Setting(containerEl)
      .setName("手写件路由表")
      .setDesc(
        "一行一条：文件名关键词（| 分隔多个） => 目标作业目录。文件名命中关键词就归档到那个目录；没命中的留在荣耀分享目录。"
      )
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.handwritingRoutes);
        text.inputEl.rows = 9;
        text.inputEl.style.width = "100%";
        text.inputEl.style.fontFamily = "ui-monospace, monospace";
        text.onChange(async (value) => {
          this.plugin.settings.handwritingRoutes = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("自动建作业记录")
      .setDesc("归档时如果目标目录还没有同名 md，自动建一篇极简作业记录（type: work）。")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoCreateRecord).onChange(async (v) => {
          this.plugin.settings.autoCreateRecord = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("外部编辑器命令")
      .setDesc('代码文件用哪个编辑器打开，{path} 是绝对路径，{dir} 是所在目录。默认 code "{path}"')
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_EDITOR)
          .setValue(this.plugin.settings.editorCommand || "")
          .onChange(async (value) => {
            this.plugin.settings.editorCommand = value || DEFAULT_EDITOR;
            await this.plugin.saveSettings();
          })
      );

    if (IS_WIN) {
      new Setting(containerEl)
        .setName("VS Code 可执行文件")
        .setDesc("留空自动探测 Code.exe；文件夹菜单里的「在 VS Code 打开」用它，路径含中文也不受影响。")
        .addText((text) =>
          text
            .setPlaceholder("%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe")
            .setValue(this.plugin.settings.vsCodePath || "")
            .onChange(async (value) => {
              this.plugin.settings.vsCodePath = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Visual Studio 可执行文件")
        .setDesc("留空按版本目录自动找 devenv.exe；文件夹里有 .sln 时开解决方案，没有就按「打开文件夹」处理。")
        .addText((text) =>
          text
            .setPlaceholder("C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\Common7\\IDE\\devenv.exe")
            .setValue(this.plugin.settings.devenvPath || "")
            .onChange(async (value) => {
              this.plugin.settings.devenvPath = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("运行命令")
      .setDesc("扩展名: 命令，一行一条，{file} 是文件名，{base} 是去掉扩展名的名字。命令在 Terminal 里执行。")
      .addTextArea((area) =>
        area
          .setValue(this.plugin.settings.runCommands || "")
          .onChange(async (value) => {
            this.plugin.settings.runCommands = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("新建文件的默认后缀")
      .setDesc("新建时只写名字、不写后缀，就用这个。默认 py")
      .addText((text) =>
        text
          .setPlaceholder("py")
          .setValue(this.plugin.settings.defaultExt || "py")
          .onChange(async (value) => {
            this.plugin.settings.defaultExt = value.trim().replace(/^\./, "") || "py";
            await this.plugin.saveSettings();
          })
      );

  }
}

// 右侧面板：每门课一条游标（学到了哪个文件第几页），点一下直接跳回去
class ProgressView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return PROGRESS_VIEW;
  }

  getDisplayText() {
    return "学习进度";
  }

  getIcon() {
    return "lucide-flag";
  }

  async onOpen() {
    this.refresh();
  }

  async onClose() {}

  refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("mn-group");

    const entries = Object.entries(this.plugin.settings.progress || {});
    if (entries.length === 0) {
      container.createEl("p", {
        text: "还没有标记过进度。看着材料时用 ⋯ 菜单或命令「标记学习进度」记一笔。",
        cls: "mn-empty",
      });
      return;
    }

    entries.sort((a, b) => (b[1].updated || 0) - (a[1].updated || 0));
    for (const [course, entry] of entries) {
      const row = container.createDiv({ cls: "mn-row" });
      const icon = row.createSpan({ cls: "mn-icon" });
      setIcon(icon, "lucide-flag");

      const box = row.createDiv({ cls: "mn-progress" });
      box.createEl("div", { text: course, cls: "mn-progress-course" });
      const meta = box.createEl("div", { cls: "mn-progress-meta" });
      const name = String(entry.file || "").split("/").pop().replace(/\.[^.]+$/, "");
      meta.createSpan({ text: entry.page ? `${name} · 第 ${entry.page} 页` : name, cls: "mn-progress-file" });
      meta.createSpan({ text: this.plugin.relativeTime(entry.updated || 0), cls: "mn-progress-time" });

      const clear = row.createSpan({ cls: "mn-clear", attr: { "aria-label": "清除这条进度" } });
      setIcon(clear, "lucide-x");
      clear.onclick = (event) => {
        event.stopPropagation();
        this.plugin.clearProgress(course);
      };
      row.onclick = () => this.plugin.jumpToProgress(course);
    }
  }
}

class MaterialSuggest extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("选一份材料");
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return `${file.basename}  ·  ${file.parent ? file.parent.path : ""}`;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class PdfNotePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign(
      {
        editorCommand: DEFAULT_EDITOR,
        runCommands: DEFAULT_RUNS,
        defaultExt: "py",
        vsCodePath: "",
        devenvPath: "",
        macApp: "Visual Studio Code",
        slotOrder: "课件,实验,参考,视频,笔记,作业,作业文件",
        labFolders: "实验,上机,实践",
        labKeywords: "实验,上机,实践,作业",
        shareInboxDir: "D:/HONOR Share/Honor Share",
        handwritingRoutes: [
          "高等数学|微积分|高数 => 备考/微积分2（重修）/产出/作业",
          "信息检索|数据挖掘 => 在读/信息检索与数据挖掘/产出/作业",
          "神经网络|深度学习 => 在读/神经网络与深度学习/产出/作业",
          "图形学 => 在读/计算机图学课程/产出/作业",
          "大数据 => 在读/大数据管理与分析/产出/作业",
          "机器人 => 在读/机器人工程实践/产出/作业",
          "情景交流|口语 => 在读/情景交流/产出/作业",
          "人工智能应用 => 在读/人工智能应用实践/产出/作业",
        ].join("\n"),
        autoCreateRecord: true,
        progress: {},
      },
      await this.loadData()
    );

    this.shareWatcher = null;
    this.pendingShares = new Map();
    this.lastRouteNotice = 0;

    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.restartShareWatcher(), 3000);
    });
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        /* 缓存就绪后再补一次监听，防止启动时目录还没建 */
        if (!this.shareWatcher) this.restartShareWatcher();
      })
    );

    // 菜单最先挂，后面任何一步出错都不至于整个菜单消失
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, source, leaf) => {
        // 预览视图右上角 ⋯（source = more-options）里，导航仪的操作独立成组
        if (source === "more-options") menu.addSeparator();
        if (file instanceof TFolder) {
          this.addFolderMenu(menu, file);
          return;
        }
        if (!(file instanceof TFile)) return;
        if (this.isMediaEntry(file)) {
          this.addMediaMenu(menu, file);
          return;
        }
        // 代码文件可能同时是材料：运行/编辑器入口与材料菜单都挂
        if (this.isCode(file)) this.addCodeMenu(menu, file);
        if (IS_WIN && VS_OPENABLE_EXT.has(String(file.extension || "").toLowerCase()))
          this.addVisualStudioMenu(menu, file);
        if (this.isMaterial(file)) this.addMenuItem(menu, file);
        else if (file.extension.toLowerCase() === "md") this.addNoteMenu(menu, file);
      })
    );

    this.addSettingTab(new MaterialSettings(this.app, this));

    this.addCommand({
      id: "new-code-file",
      name: "新建文件",
      callback: () => this.promptNewFile(null),
    });

    this.addCommand({
      id: "archive-handwriting",
      name: "手写件归档到作业…",
      callback: () => this.archiveHandwriting(),
    });

    this.addCommand({
      id: "open-folder-in-vscode",
      name: "用 VS Code 打开当前文件所在文件夹",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) {
          const folder = file.parent || this.app.vault.getRoot();
          this.openFolderInEditor(folder);
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-file-in-vscode",
      name: "用 VS Code 打开当前文件",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openInEditor(file);
        return true;
      },
    });

    if (IS_WIN) {
      this.addCommand({
        id: "open-folder-in-visual-studio",
        name: "用 Visual Studio 打开当前文件所在文件夹",
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return false;
          if (!checking) {
            const folder = file.parent || this.app.vault.getRoot();
            this.openInVisualStudio(folder);
          }
          return true;
        },
      });
    }

    this.addCommand({
      id: "run-code-file",
      name: "运行当前代码文件",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = Boolean(file && this.hasRun(file));
        if (ok && !checking) this.runCode(file);
        return ok;
      },
    });

    this.addCommand({
      id: "open-current-in-default-app",
      name: "用系统默认应用打开当前文件",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.app.openWithDefaultApp(file.path);
        return true;
      },
    });

    this.addCommand({
      id: "reload-self",
      name: "重载本插件",
      callback: async () => {
        const id = this.manifest.id;
        await this.app.plugins.disablePlugin(id);
        await this.app.plugins.enablePlugin(id);
        new Notice("Course Navigator 已重载");
      },
    });

    this.addCommand({
      id: "plugin-status",
      name: "查看插件状态",
      callback: () => {
        new Notice(`Course Navigator ${this.manifest.version}`, 8000);
      },
    });

    this.addCommand({
      id: "show-group",
      name: "打开本组面板",
      callback: () => this.activateGroupView(),
    });

    this.registerView(VIEW_TYPE, (leaf) => new GroupView(leaf, this));
    this.registerView(PROGRESS_VIEW, (leaf) => new ProgressView(leaf, this));
    this.addRibbonIcon("lucide-layers", "本组文件", () => this.activateGroupView());
    this.addRibbonIcon("lucide-flag", "学习进度", () => this.activateProgressView());
    this.addCommand({
      id: "show-progress",
      name: "打开学习进度面板",
      callback: () => this.activateProgressView(),
    });
    this.addCommand({
      id: "mark-progress",
      name: "标记学习进度",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const ok = Boolean(file && this.courseOf(file));
        if (ok && !checking) this.markProgress(file);
        return ok;
      },
    });
    this.addCommand({
      id: "goto-progress",
      name: "跳到这门课的学习进度",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const course = file && this.courseOf(file);
        const ok = Boolean(course && this.settings.progress?.[course]);
        if (ok && !checking) this.jumpToProgress(course);
        return ok;
      },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refreshGroupView())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.refreshGroupView())
    );

  }

  async activateGroupView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    this.refreshGroupView();
  }

  async activateProgressView() {
    let leaf = this.app.workspace.getLeavesOfType(PROGRESS_VIEW)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: PROGRESS_VIEW, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    for (const open of this.app.workspace.getLeavesOfType(PROGRESS_VIEW)) open.view?.refresh?.();
  }

  // ===== 学习进度：每门课一条游标，指向学到的那个文件第几页 =====

  // 这份文件归哪门课：材料路径里最后的「材料」之前那段的末段就是科目
  courseOf(file) {
    if (!(file instanceof TFile)) return null;
    const material = this.materialOf(file) || file;
    const posix = material.path.replace(/\\/g, "/");
    if (!posix.includes(`/${MATERIAL}/`)) return null;
    return this.subject(material);
  }

  // 科目当前这条进度（只认进度指向的文件本身，别组的文件不显示徽标）
  progressEntryFor(file) {
    if (!(file instanceof TFile)) return null;
    const course = this.courseOf(file);
    if (!course) return null;
    const entry = (this.settings.progress || {})[course];
    return entry && entry.file === file.path ? entry : null;
  }

  // 已打开的 PDF 视图里的 pdf.js viewer（同 PDF++ 的取法），能读也能设页码
  pdfViewerOf(file) {
    const leaf = this.findLeafFor(file);
    if (!leaf || leaf.view?.getViewType?.() !== "pdf") return null;
    const viewer = leaf.view?.viewer?.pdfViewer?.pdfViewer;
    return viewer && Number.isFinite(Number(viewer.currentPageNumber)) ? viewer : null;
  }

  // 标记：把这份材料（当前看到的那一页）记成这门课的游标
  async markProgress(file) {
    const active = file || this.app.workspace.getActiveFile();
    if (!active) {
      new Notice("没有当前文件");
      return;
    }
    const course = this.courseOf(active);
    if (!course) {
      new Notice("认不出这份材料属于哪门课");
      return;
    }
    const material = this.materialOf(active) || active;
    // 媒体条目记视频/音频本身；其余记解析出的材料
    const target = this.isMediaEntry(active) ? this.mediaFile(active) || active : material;
    const viewer = this.pdfViewerOf(target);
    const page = viewer ? Math.round(Number(viewer.currentPageNumber)) : null;

    this.settings.progress = this.settings.progress || {};
    this.settings.progress[course] = { file: target.path, page, updated: Date.now() };
    await this.saveSettings();
    new Notice(page ? `已标记 ${course}：${target.basename} 第 ${page} 页` : `已标记 ${course}：${target.basename}`);
    this.refreshGroupView();
  }

  // 跳回某门课的游标：已开着就定位页码，没开就用原生 #page= 链接打开
  async jumpToProgress(course) {
    const entry = (this.settings.progress || {})[course];
    if (!entry) {
      new Notice(`${course} 还没有学习进度`);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(entry.file);
    if (!(file instanceof TFile)) {
      new Notice(`进度指向的文件不在了，已清除：${entry.file}`);
      delete this.settings.progress[course];
      await this.saveSettings();
      this.refreshGroupView();
      return;
    }
    const target = file;
    const open = this.findLeafFor(target);
    if (open) {
      await this.focusLeaf(open);
      this.gotoPage(open, entry.page);
      return;
    }
    await this.app.workspace.openLinkText(entry.page ? `${target.path}#page=${entry.page}` : target.path, "", { active: true });
    // 已开着的标签走 openLinkText 不一定吃 #page= 参数，兜底再设一次页码
    window.setTimeout(() => {
      const leaf = this.findLeafFor(target);
      if (leaf) this.gotoPage(leaf, entry.page);
    }, 350);
  }

  gotoPage(leaf, page) {
    const target = Number(page);
    if (!Number.isFinite(target) || target <= 0) return;
    const viewer = leaf.view?.viewer?.pdfViewer?.pdfViewer;
    if (!viewer || Math.round(Number(viewer.currentPageNumber)) === target) return;
    try {
      viewer.currentPageNumber = target;
    } catch (error) {
      console.warn("[pdf-note] 定位页码失败", error);
    }
  }

  async clearProgress(course) {
    delete this.settings.progress[course];
    await this.saveSettings();
    new Notice(`已清除 ${course} 的学习进度`);
    this.refreshGroupView();
  }

  relativeTime(ts) {
    const days = Math.floor((Date.now() - Number(ts || 0)) / 86400000);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    const d = new Date(Number(ts));
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }


  onunload() {
    this.unwatchShareDir();
  }

  refreshGroupView() {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      for (const type of [VIEW_TYPE, PROGRESS_VIEW]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) leaf.view?.refresh?.();
      }
    }, 250);
  }

  get propName() {
    return this.app.plugins?.plugins?.["pdf-plus"]?.settings?.proxyMDProperty || DEFAULT_PROP;
  }

  propFor(file) {
    return file.extension.toLowerCase() === "pdf" ? this.propName : MATERIAL_PROP;
  }

  // 材料目录下的一切都算素材：pdf 之外还有 docx、pptx、ipynb、源码压缩包
  isMaterial(file) {
    const ext = file.extension.toLowerCase();
    if (ext === "md" || ext === "canvas") return false;
    return file.path.includes(`/${MATERIAL}/`);
  }

  // 反过来：从笔记跳到它挂的那份材料
  addNoteMenu(menu, note) {
    const links = this.app.metadataCache.getFileCache(note)?.frontmatterLinks;
    if (!links) return;
    const props = [this.propName, MATERIAL_PROP];

    for (const link of links) {
      if (!props.some((prop) => link.key === prop || link.key.startsWith(prop + "."))) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkTarget(link.link), note.path);
      if (!dest) continue;
      menu.addItem((item) =>
        item
          .setTitle("打开对应材料")
          .setIcon("lucide-file-input")
          .onClick(() => this.openMaterial(dest))
      );
      menu.addItem((item) =>
        item
          .setTitle("标记学习进度")
          .setIcon("lucide-flag")
          .onClick(() => this.markProgress(note))
      );
      return;
    }
  }

  // 能不能在 Obsidian 里直接渲染
  hasView(file) {
    return Boolean(this.app.viewRegistry?.getTypeByExtension?.(file.extension.toLowerCase()));
  }

  // 同一个文件已经在某个标签里开着，就把那个标签提上来，不再开新的
  findLeafFor(file) {
    let found = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view?.file?.path === file.path) found = leaf;
    });
    return found;
  }

  async focusLeaf(leaf) {
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  // 统一打开协议：导航仪自己不做任何预览。
  // Obsidian 里注册了视图就交出去（原生 PDF/图片/音视频，以及 Office Reader、
  // HTML Reader、Media Extended、Jupyter reader 等外部插件注册的扩展名）；
  // 代码文件交给外部编辑器；其余交给系统默认应用。
  async openMaterial(file) {
    const open = this.findLeafFor(file);
    if (open) {
      await this.focusLeaf(open);
      return;
    }
    if (this.hasView(file)) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      return;
    }
    if (this.isCode(file)) {
      this.openInEditor(file);
      return;
    }
    await this.app.openWithDefaultApp(file.path);
  }

  // 作业记录旁边的同名文件夹就是这一组的交付物
  workFiles(records) {
    const out = [];
    for (const record of records) {
      const folderPath = normalizePath(`${record.parent ? record.parent.path : ""}/${record.basename}`);
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!(folder instanceof TFolder)) continue;
      const walk = (node) => {
        for (const child of node.children) {
          if (child instanceof TFolder) walk(child);
          else if (!child.name.startsWith(".")) out.push(child);
        }
      };
      walk(folder);
    }

    // 与记录同名的散装文件，比如 xxx.py、xxx.png
    for (const record of records) {
      const parent = record.parent;
      if (!(parent instanceof TFolder)) continue;
      for (const child of parent.children) {
        if (!(child instanceof TFile)) continue;
        if (child.path === record.path) continue;
        if (child.name.startsWith(record.basename) && !out.includes(child)) out.push(child);
      }
    }
    return out;
  }

  // media-extended 的媒体条目：frontmatter 里带 mx-uid
  isMediaEntry(note) {
    if (!note || note.extension?.toLowerCase() !== "md") return false;
    return Boolean(this.app.metadataCache.getFileCache(note)?.frontmatter?.["mx-uid"]);
  }

  mediaEntries() {
    return this.app.vault.getMarkdownFiles().filter((note) => this.isMediaEntry(note));
  }

  // 这一组对应的视频：属性指过来的优先，没有就按文件名与材料对上
  videosFor(members) {
    const names = members.map((file) => file.basename).filter(Boolean);
    const paths = new Set(members.map((file) => file.path));
    if (names.length === 0) return [];

    const out = [];
    for (const note of this.mediaEntries()) {
      const cache = this.app.metadataCache.getFileCache(note);
      let hit = false;

      for (const link of cache?.frontmatterLinks || []) {
        if (!["材料", "PDF", "课件", "来源"].includes(link.key)) continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(linkTarget(link.link), note.path);
        if (dest && paths.has(dest.path)) {
          hit = true;
          break;
        }
      }

      if (!hit) {
        hit = names.some(
          (name) =>
            note.basename === name ||
            note.basename.startsWith(`${name}-`) ||
            note.basename.startsWith(`${name}_`) ||
            name.startsWith(`${note.basename}-`)
        );
      }

      if (hit) out.push(note);
    }
    return out;
  }

  addMediaMenu(menu, note) {
    const media = this.mediaFile(note);
    if (media) {
      menu.addItem((item) =>
        item.setTitle("播放").setIcon("lucide-play").onClick(() => this.openMaterial(media))
      );
    }
    menu.addItem((item) =>
      item.setTitle("标记学习进度").setIcon("lucide-flag").onClick(() => this.markProgress(note))
    );
    menu.addItem((item) =>
      item.setTitle("关联到材料…").setIcon("lucide-link").onClick(() => this.askMaterial(note))
    );
  }

  askMaterial(note) {
    const files = this.app.vault
      .getFiles()
      .filter((file) => this.isMaterial(file))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) {
      new Notice("材料目录里还没有文件");
      return;
    }
    new MaterialSuggest(this.app, files, async (target) => {
      try {
        await this.app.fileManager.processFrontMatter(note, (fm) => {
          fm[MATERIAL_PROP] = `[[${target.path}|${target.basename}]]`;
        });
        new Notice(`已关联到 ${target.basename}`);
      } catch (error) {
        console.error("[course-navigator]", error);
        new Notice(`关联失败：${error.message}`);
      }
    }).open();
  }

  // 媒体条目里 video/media/audio 指向的那个文件
  mediaFile(note) {
    const links = this.app.metadataCache.getFileCache(note)?.frontmatterLinks || [];
    for (const link of links) {
      if (!["video", "media", "audio"].includes(link.key)) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkTarget(link.link), note.path);
      if (dest) return dest;
    }
    return null;
  }

  // 面板里点一行时实际要打开的东西：视频条目打开视频本身，其余材料原样交给统一协议
  mediaTarget(file) {
    const media = file.extension.toLowerCase() === "md" && this.isMediaEntry(file) ? this.mediaFile(file) : null;
    return media || file;
  }

  // 媒体条目的时长，秒 -> mm:ss
  mediaDuration(note) {
    const seconds = Number(this.app.metadataCache.getFileCache(note)?.frontmatter?.duration);
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  parseRuns() {
    const map = {};
    for (const line of String(this.settings.runCommands || "").split("\n")) {
      const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.+)$/);
      if (match) map[match[1].toLowerCase()] = match[2].trim();
    }
    return map;
  }

  hasRun(file) {
    return Boolean(this.parseRuns()[file.extension.toLowerCase()]);
  }

  isCode(file) {
    const ext = file.extension.toLowerCase();
    return CODE_EXT.has(ext) || this.hasRun(file);
  }

  addCodeMenu(menu, file) {
    if (this.hasRun(file)) {
      menu.addItem((item) =>
        item.setTitle("在终端运行").setIcon("lucide-play").onClick(() => this.runCode(file))
      );
    }
    menu.addItem((item) =>
      item.setTitle("在外部编辑器打开").setIcon("lucide-square-terminal").onClick(() => this.openInEditor(file))
    );
  }

  async runCode(file) {
    const template = this.parseRuns()[file.extension.toLowerCase()];
    if (!template) {
      new Notice(`没有为 .${file.extension} 配运行命令`);
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;

    const dir = adapter.getFullPath(file.parent ? file.parent.path : "");
    const command = template
      .split("{file}").join(file.name)
      .split("{path}").join(adapter.getFullPath(file.path))
      .split("{dir}").join(dir)
      .split("{base}").join(file.basename);

    const script = path.join(os.tmpdir(), `obsidian-run-${Date.now()}.command`);
    fs.writeFileSync(script, `#!/bin/zsh\ncd ${shellQuote(dir)}\n${command}\n`, { mode: 0o755 });
    const child = spawn("open", ["-a", "Terminal", script]);
    child.on("error", (error) => new Notice(`启动终端失败：${error.message}`));
    child.on("close", (code) => {
      if (code !== 0) new Notice(`启动终端失败：退出码 ${code}`);
    });
  }

  openInEditor(file) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = adapter.getFullPath(file.path);
    const dir = adapter.getFullPath(file.parent ? file.parent.path : "");

    if (IS_WIN) {
      this.launchExternal(abs);
      return;
    }

    const command = String(this.settings.editorCommand || DEFAULT_EDITOR)
      .split("{path}").join(abs)
      .split("{dir}").join(dir);

    // Obsidian 的环境变量很短，zsh 走登录模式并把常用 bin 补到前面，code 这类 CLI 才找得到
    const env = Object.assign({}, process.env, {
      PATH: `/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || "/usr/bin:/bin"}`,
    });
    const child = spawn("/bin/zsh", ["-lc", command], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => new Notice(`打开编辑器失败：${error.message}`));
    child.on("close", (code) => {
      if (code !== 0) new Notice(`打开编辑器失败：${stderr.trim() || `退出码 ${code}`}`);
    });
  }

  addFolderMenu(menu, folder) {
    menu.addItem((item) =>
      item
        .setTitle("新建文件…")
        .setIcon("lucide-file-plus")
        .onClick(() => this.promptNewFile(folder.path))
    );
    menu.addItem((item) =>
      item
        .setTitle("在 VS Code 打开")
        .setIcon("lucide-code")
        .onClick(() => this.openFolderInEditor(folder))
    );
    if (IS_WIN) {
      menu.addItem((item) =>
        item
          .setTitle("在 Visual Studio 打开")
          .setIcon("lucide-monitor-play")
          .onClick(() => this.openInVisualStudio(folder))
      );
    }
    menu.addItem((item) =>
      item
        .setTitle(IS_WIN ? "在资源管理器中显示" : "在 Finder 中显示")
        .setIcon("lucide-folder-open")
        .onClick(() => this.revealInSystem(folder))
    );
  }

  addVisualStudioMenu(menu, file) {
    menu.addItem((item) =>
      item
        .setTitle("在 Visual Studio 打开")
        .setIcon("lucide-monitor-play")
        .onClick(() => this.openInVisualStudio(file))
    );
    menu.addItem((item) =>
      item
        .setTitle("在 VS Code 打开")
        .setIcon("lucide-code")
        .onClick(() => this.openInEditor(file))
    );
  }

  vsCodePath() {
    const custom = String(this.settings.vsCodePath || "").trim();
    if (custom && fs.existsSync(custom)) return custom;
    for (const candidate of VSCODE_CANDIDATES) {
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (error) {
        console.error("[course-navigator]", error);
      }
    }
    return null;
  }

  // 直接起编辑器进程，参数按数组传，路径里的中文和空格原样过去
  launchExternal(targetPath) {
    if (IS_WIN) {
      const exe = this.vsCodePath();
      if (!exe) {
        new Notice("没找到 VS Code，请在「Course Navigator」设置里填 Code.exe 的路径");
        return;
      }
      try {
        spawn(exe, [targetPath], { detached: true, stdio: "ignore" }).unref();
      } catch (error) {
        new Notice(`打开 VS Code 失败：${error.message}`);
      }
      return;
    }

    const child = spawn("open", ["-a", this.settings.macApp || "Visual Studio Code", targetPath]);
    child.on("error", (error) => new Notice(`打开 VS Code 失败：${error.message}`));
  }

  openFolderInEditor(folder) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = adapter.getFullPath(folder.path);
    this.launchExternal(abs);
  }

  devenvPath() {
    const custom = String(this.settings.devenvPath || "").trim();
    if (custom && fs.existsSync(custom)) return custom;
    return findDevenv();
  }

  // 文件夹里有 .sln 就开解决方案，没有就让 VS 按「打开文件夹」处理
  findSolutionIn(folder) {
    let level = [folder];
    for (let depth = 0; depth < 3; depth += 1) {
      const next = [];
      for (const dir of level) {
        for (const child of dir.children || []) {
          if (child instanceof TFile && SOLUTION_EXT.has(String(child.extension || "").toLowerCase())) {
            return child;
          }
          if (child instanceof TFolder) next.push(child);
        }
      }
      if (!next.length) break;
      level = next;
    }
    return null;
  }

  openInVisualStudio(target) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const exe = this.devenvPath();
    if (!exe) {
      new Notice("没找到 Visual Studio，请在「Course Navigator」设置里填 devenv.exe 的路径");
      return;
    }
    let targetPath = null;
    if (target instanceof TFile) {
      targetPath = adapter.getFullPath(target.path);
    } else if (target instanceof TFolder) {
      const solution = this.findSolutionIn(target);
      targetPath = adapter.getFullPath(solution ? solution.path : target.path);
    }
    if (!targetPath) return;
    try {
      spawn(exe, [targetPath], { detached: true, stdio: "ignore" }).unref();
    } catch (error) {
      new Notice(`打开 Visual Studio 失败：${error.message}`);
    }
  }

  revealInSystem(folder) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const abs = adapter.getFullPath(folder.path);
    try {
      if (IS_WIN) {
        // explorer 打不开路径时也会返回 1，不看退出码
        spawn("explorer.exe", [abs], { detached: true, stdio: "ignore" }).unref();
      } else {
        spawn("open", [abs]);
      }
    } catch (error) {
      new Notice(`打开文件夹失败：${error.message}`);
    }
  }

  promptNewFile(folderPath) {
    const fallback = this.app.workspace.getActiveFile()?.parent?.path || "在读";
    const target = folderPath || fallback;
    const ext = this.settings.defaultExt || "py";
    new TextPromptModal(
      this.app,
      "新建文件",
      `文件名，可带后缀；不写后缀就用 .${ext}`,
      (name) => this.createFile(name, target)
    ).open();
  }

  async createFile(name, folderPath) {
    try {
      const trimmed = name.trim();
      if (!trimmed) return;
      const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
      const fileName = hasExt ? trimmed : `${trimmed}.${this.settings.defaultExt || "py"}`;
      const filePath = normalizePath(`${folderPath}/${fileName}`);

      let file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) file = await this.app.vault.create(filePath, "");

      new Notice(`已创建 ${fileName}`);
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    } catch (error) {
      console.error("[course-navigator]", error);
      new Notice(`创建失败：${error.message}`);
    }
  }


  // 属性里的链接解析成文件
  propLink(file, keys) {
    const links = this.app.metadataCache.getFileCache(file)?.frontmatterLinks;
    if (!links) return null;
    for (const link of links) {
      if (!keys.some((key) => link.key === key || link.key.startsWith(key + "."))) continue;
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkTarget(link.link), file.path);
      if (dest) return dest;
    }
    return null;
  }

  // 笔记 → 材料；材料本身直接返回
  materialOf(file) {
    if (this.isMaterial(file)) return file;
    const ext = file.extension.toLowerCase();
    if (ext === "canvas") return this.materialForUnbound(file);
    if (ext !== "md") return null;
    return this.propLink(file, [this.propName, MATERIAL_PROP]);
  }

  // canvas 放不了属性：按标题找一篇绑定了材料的 md，顺着它回到材料
  materialForUnbound(file) {
    const title = noteTitle(file);
    for (const note of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(note);
      if (cache?.frontmatter?.["mx-uid"]) continue;
      const material = this.propLink(note, [this.propName, MATERIAL_PROP]);
      if (material && noteTitle(note) === title) return material;
    }
    return null;
  }

  // 哪篇作业记录挂在讲次上
  recordsForLecture(lecture) {
    const out = [];
    for (const note of this.app.vault.getMarkdownFiles()) {
      const linked = this.propLink(note, [LECTURE]);
      if (linked && linked.path === lecture.path) out.push(note);
    }
    return out;
  }

  // 作业目录里那些没有属性的文件（py、png），靠同目录同名前缀的记录认领
  recordFor(file) {
    const parent = file.parent;
    if (!(parent instanceof TFolder)) return null;
    let best = null;
    for (const child of parent.children) {
      if (!(child instanceof TFile) || child.extension.toLowerCase() !== "md") continue;
      if (child.path === file.path) continue;
      if (file.name.startsWith(child.basename) || file.basename === child.basename) {
        if (!best || child.basename.length > best.basename.length) best = child;
      }
    }
    return best;
  }

  buildGroup(file) {
    let material = this.materialOf(file);
    if (!material && file.extension.toLowerCase() !== "md") {
      const record = this.recordFor(file);
      if (record) material = this.propLink(record, [this.propName, MATERIAL_PROP]);
    }
    if (!material) return null;

    let lab = null;
    let lecture = null;
    let records = [];

    if (this.isLab(material)) {
      lab = material;
      records = this.collect(lab).work;
      lecture = records.length > 0 ? this.propLink(records[0], [LECTURE]) : null;
    } else {
      lecture = material;
      records = this.recordsForLecture(lecture);
      if (records.length > 0) lab = this.propLink(records[0], [this.propName, MATERIAL_PROP]);
    }

    const members = [lecture, lab, ...records].filter(Boolean);
    const videos = this.videosFor(members);
    const workFiles = this.workFiles(records);

    // 按「文件所在目录名」自动分段：库里有什么目录就只出哪几段。
    // 微积分这种没有 课件/实验 的课不会再顶着一个空段。
    const buckets = new Map();
    const push = (f, forced) => {
      if (!f) return;
      const key = forced || (f.parent ? f.parent.name : "其他");
      if (!buckets.has(key)) buckets.set(key, []);
      const list = buckets.get(key);
      if (!list.some((x) => x.path === f.path)) list.push(f);
    };

    push(lecture);
    push(lab);
    if (lecture) for (const f of this.collect(lecture).study) push(f);
    if (lab) for (const f of this.collect(lab).study) push(f);
    for (const f of records) push(f);
    for (const f of workFiles) push(f, "作业文件");
    for (const f of videos) push(f, "视频");

    const order = splitList(this.settings.slotOrder);
    const rank = (name) => {
      const i = order.indexOf(name);
      return i === -1 ? order.length + 1 : i;
    };
    const labels = [...buckets.keys()].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return diff !== 0 ? diff : a.localeCompare(b, "zh");
    });

    const sections = labels
      .map((label) => ({ label, files: buckets.get(label) }))
      .filter((section) => section.files.length > 0);

    return { lecture: lecture || lab, lab, sections };
  }

  addMenuItem(menu, pdf) {
    const { study, work } = this.collect(pdf);

    // 统一协议之外的格式给一个系统应用入口，其余类型 Obsidian 里直接开
    if (!this.hasView(pdf) && !this.isCode(pdf)) {
      menu.addItem((item) =>
        item
          .setTitle("用系统默认应用打开")
          .setIcon("lucide-external-link")
          .onClick(() => this.app.openWithDefaultApp(pdf.path))
      );
    }

    if (study.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(study.length === 1 ? "打开对应笔记" : `打开对应笔记（${study.length} 篇）`)
          .setIcon("lucide-file-text")
          .onClick((event) => {
            if (study.length === 1) this.openFile(study[0]);
            else this.showChooser(event, study);
          })
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle("新建文本笔记")
          .setIcon("lucide-file-plus")
          .onClick(() => this.createNote(pdf, "md"))
      );
      menu.addItem((item) =>
        item
          .setTitle("新建画板笔记")
          .setIcon("lucide-layout-dashboard")
          .onClick(() => this.createNote(pdf, "canvas"))
      );
      menu.addItem((item) =>
        item
          .setTitle("新建 Excalidraw 笔记")
          .setIcon("lucide-pencil-ruler")
          .onClick(() => this.createNote(pdf, "excalidraw"))
      );
    }

    menu.addItem((item) =>
      item
        .setTitle("标记学习进度")
        .setIcon("lucide-flag")
        .onClick(() => this.markProgress(pdf))
    );

    if (!this.isLab(pdf)) return;

    if (work.length > 0) {
      menu.addItem((item) =>
        item
          .setTitle(work.length === 1 ? "打开作业" : `打开作业（${work.length} 篇）`)
          .setIcon("lucide-folder-open")
          .onClick((event) => {
            if (work.length === 1) this.openFile(work[0]);
            else this.showChooser(event, work);
          })
      );
      if (work.length === 1) {
        menu.addItem((item) =>
          item
            .setTitle("关联课件…")
            .setIcon("lucide-link")
            .onClick(() => this.askLecture(work[0], pdf))
        );
      }
    } else {
      menu.addItem((item) =>
        item
          .setTitle("新建作业记录")
          .setIcon("lucide-clipboard-list")
          .onClick(() => this.createWorkRecord(pdf, study[0]))
      );
    }
  }

  // 显式绑定的优先，其次是本科目 笔记/ 里的同名文件，最后是全库同名
  collect(pdf) {
    const props = [this.propName, MATERIAL_PROP];
    const boundStudy = [];
    const boundWork = [];

    for (const note of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(note);
      const links = cache?.frontmatterLinks;
      if (!links) continue;
      // 媒体库条目走「视频」段，不算学习笔记
      if (cache?.frontmatter?.["mx-uid"]) continue;
      for (const link of links) {
        if (!props.some((prop) => link.key === prop || link.key.startsWith(prop + "."))) continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(linkTarget(link.link), note.path);
        if (!dest || dest.path !== pdf.path) continue;
        (isWorkFile(note) ? boundWork : boundStudy).push(note);
        break;
      }
    }

    // canvas / excalidraw 笔记没法绑属性，靠同名兜底补进来；绑定的 md 永远排前面
    const titleMatched = this.collectByTitle(pdf, [...boundWork, ...boundStudy]);
    const study = [...boundStudy, ...titleMatched];
    return { study, work: boundWork };
  }

  collectByTitle(pdf, exclude) {
    const skipped = new Set(exclude.map((note) => note.path));
    const near = [];
    const far = [];
    const notesRoot = this.notesRoot(pdf);

    // 本科目的笔记目录不大，直接递归，免得全库扫一遍
    if (notesRoot) {
      const folder = this.app.vault.getAbstractFileByPath(notesRoot);
      if (folder instanceof TFolder) this.collectInFolder(folder, pdf.basename, skipped, near);
      if (near.length > 0) return near;
    }

    for (const note of this.app.vault.getFiles()) {
      if (!(note instanceof TFile) || !isNote(note)) continue;
      if (skipped.has(note.path)) continue;
      if (this.isMediaEntry(note)) continue;
      if (noteTitle(note) === pdf.basename) far.push(note);
    }
    return far;
  }

  collectInFolder(folder, basename, skipped, out) {
    for (const child of folder.children) {
      if (child instanceof TFolder) this.collectInFolder(child, basename, skipped, out);
      else if (child instanceof TFile && isNote(child) && !isWorkFile(child) && !skipped.has(child.path) && noteTitle(child) === basename) {
        out.push(child);
      }
    }
  }

  showChooser(event, notes) {
    const menu = new Menu();
    for (const note of notes) {
      menu.addItem((item) =>
        item
          .setTitle(note.path)
          .setIcon("lucide-file-text")
          .onClick(() => this.openFile(note))
      );
    }
    menu.showAtMouseEvent(event);
  }

  async openFile(note) {
    const open = this.findLeafFor(note);
    if (open) {
      await this.focusLeaf(open);
      return;
    }

    const leaf = this.app.workspace.getLeaf("split", "vertical");
    await leaf.openFile(note);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async createNote(pdf, form) {
    try {
      const folder = await this.ensureFolder(`${this.notesRoot(pdf)}/${STUDY}`);
      const fileName = form === "excalidraw" ? `${pdf.basename}.excalidraw.md` : `${pdf.basename}.${form}`;
      const path = normalizePath(`${folder}/${fileName}`);
      let note = this.app.vault.getAbstractFileByPath(path);

      if (!(note instanceof TFile)) {
        let content;
        if (form === "canvas") {
          content = '{"nodes":[],"edges":[]}';
        } else {
          const lines = this.buildFrontmatter(pdf, "source");
          if (form === "excalidraw") {
            // Excalidraw 插件认这个键才会用画布视图打开；tags 已在 buildFrontmatter 里，别重复
            lines.push("excalidraw-plugin: parsed");
          }
          content = `---\n${lines.join("\n")}\n---\n`;
          if (form === "excalidraw") content += EXCALIDRAW_SKELETON;
        }
        note = await this.app.vault.create(path, content);
      }

      await this.openFile(note);
    } catch (error) {
      console.error("[course-navigator]", error);
      new Notice(`无法创建对应笔记：${error.message}`);
    }
  }

  // 作业记录：作业/ 下与材料同名的一篇笔记，把材料、学习笔记和交上去的东西挂在一起
  async createWorkRecord(pdf, study) {
    try {
      const folder = await this.ensureFolder(`${this.notesRoot(pdf)}/${WORK}`);
      const path = normalizePath(`${folder}/${pdf.basename}.md`);
      let note = this.app.vault.getAbstractFileByPath(path);

      if (!(note instanceof TFile)) {
        const lines = this.buildFrontmatter(pdf, "work");
        if (study) lines.splice(3, 0, `${NOTE_PROP}: "[[${study.path.replace(/\.md$/i, "")}|${noteTitle(study)}]]"`);
        note = await this.app.vault.create(path, `---\n${lines.join("\n")}\n---\n`);
      }

      await this.openFile(note);
      this.askLecture(note, pdf, true);
    } catch (error) {
      console.error("[course-navigator]", error);
      new Notice(`无法创建作业记录：${error.message}`);
    }
  }

  // 第一次建记录时顺手问一句，之后可以从 ⋯ 菜单再改
  askLecture(note, pdf, onlyIfMissing) {
    if (onlyIfMissing) {
      const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
      if (fm && fm[LECTURE]) return;
    }

    const lectures = this.lectures(pdf);
    if (lectures.length === 0) return;

    new LectureSuggest(this.app, lectures, async (lecture) => {
      await this.app.fileManager.processFrontMatter(note, (fm) => {
        fm[LECTURE] = `[[${lecture.path}|${lecture.basename}]]`;
      });
      new Notice(`已关联课件：${lecture.basename}`);
    }).open();
  }

  lectures(pdf) {
    const subject = this.subjectRoot(pdf);
    if (!subject) return [];
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(`${subject}/${MATERIAL}/课件`));
    if (!(folder instanceof TFolder)) return [];
    const skipped = new Set(["md", "canvas"]);
    return folder.children.filter(
      (child) => child instanceof TFile && !child.name.startsWith(".") && !skipped.has(child.extension.toLowerCase())
    );
  }

  buildFrontmatter(pdf, type) {
    const subject = this.subject(pdf);
    const lines = [
      `type: ${type}`,
      `title: ${yamlString(pdf.basename)}`,
      `${this.propFor(pdf)}: "[[${pdf.path}|${pdf.basename}]]"`,
    ];
    if (subject) {
      const kind = type === "work" ? WORK : this.isLab(pdf) ? "实验" : "课件";
      lines.push(`tags: [${subject}, ${kind}]`);
    }
    lines.push(`created: ${today()}`);
    return lines;
  }

  subjectRoot(pdf) {
    const parts = pdf.path.split("/");
    const index = parts.lastIndexOf(MATERIAL);
    return index > 0 ? parts.slice(0, index).join("/") : null;
  }
  subject(pdf) {
    const root = this.subjectRoot(pdf);
    return root ? root.split("/").pop() : null;
  }

  // ===== 手写作业：平板/纸笔 → 荣耀分享 → 全自动归档 =====
  // 荣耀分享落地目录被 fs.watch 盯着；新文件落稳后按路由表找目标科目，
  // 清理文件名（去掉分享加的时间戳尾巴）、移进 <目标>/产出/作业/<作业名>/，
  // 并按需建同名作业记录。全程零操作；没匹配上路由的留在原地等手动处理。

  cleanSharedName(name) {
    let base = String(name).replace(/\.[a-z0-9]+$/i, "");
    base = base.replace(/(?:_\d+)+\s*$/, ""); // 荣耀分享的 _0_1792678636734 时间戳尾巴
    base = base.replace(/\s+/g, " ").trim();
    return base || String(name).replace(/\.[a-z0-9]+$/i, "");
  }

  parseRoutes() {
    const out = [];
    for (const line of String(this.settings.handwritingRoutes || "").split("\n")) {
      const at = line.indexOf("=>");
      if (at === -1) continue;
      const keys = line
        .slice(0, at)
        .split(/[|｜,，]/)
        .map((x) => x.trim())
        .filter(Boolean);
      const dir = line.slice(at + 2).trim();
      if (keys.length && dir) out.push({ keys, dir: normalizePath(dir) });
    }
    return out;
  }

  matchRoute(cleanBase) {
    const low = cleanBase.toLowerCase();
    return this.parseRoutes().find((route) => route.keys.some((k) => low.includes(k.toLowerCase()))) || null;
  }

  async waitStable(abs, tries = 6) {
    let last = -1;
    for (let i = 0; i < tries; i += 1) {
      let size = -1;
      try {
        size = fs.statSync(abs).size;
      } catch (error) {
        return false; // 文件已被移走
      }
      if (size === last && size > 0) return true;
      last = size;
      await new Promise((resolve) => window.setTimeout(resolve, 700));
    }
    return false;
  }

  async autoImportShared(name) {
    const shareDir = String(this.settings.shareInboxDir || "").trim();
    const abs = path.join(shareDir, name);
    if (!fs.existsSync(abs)) return;

    const base = this.cleanSharedName(name);
    const route = this.matchRoute(base);
    if (!route) {
      const now = Date.now();
      if (!this.lastRouteNotice || now - this.lastRouteNotice > 60000) {
        this.lastRouteNotice = now;
        new Notice(`手写件「${name}」没匹配到路由，留在荣耀分享目录。可在设置「手写件路由表」里加规则。`);
      }
      return;
    }
    if (!(await this.waitStable(abs))) return;

    const m = name.match(/\.([a-z0-9]+)$/i);
    const ext = (m ? m[1] : "pdf").toLowerCase();
    const workDir = normalizePath(`${route.dir}/${base}`);
    if (!(this.app.vault.getAbstractFileByPath(workDir) instanceof TFolder)) {
      await this.app.vault.createFolder(workDir).catch(() => {});
    }

    let target = normalizePath(`${workDir}/${base}.${ext}`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(target)) {
      target = normalizePath(`${workDir}/${base}-${n}.${ext}`);
      n += 1;
    }

    const data = fs.readFileSync(abs);
    await this.app.vault.createBinary(
      target,
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    );
    fs.unlinkSync(abs);

    if (this.settings.autoCreateRecord) {
      const recordPath = normalizePath(`${route.dir}/${base}.md`);
      if (!this.app.vault.getAbstractFileByPath(recordPath)) {
        await this.app.vault.create(recordPath, [
          "---",
          "type: work",
          `title: "${base}"`,
          `created: "${this.manualDate()}"`,
          "tags: []",
          "---",
          "",
        ].join("\n"));
      }
    }

    new Notice(`手写件已归档：${base}.${ext} → ${workDir}`);
    this.activateGroupView?.();
  }

  manualDate() {
    const d = new Date();
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  restartShareWatcher() {
    this.unwatchShareDir();
    const dir = String(this.settings.shareInboxDir || "").trim();
    if (!dir || !fs.existsSync(dir)) return;
    try {
      this.shareWatcher = fs.watch(dir, (_event, filename) => {
        if (!filename) return;
        if (!/\.(pdf|png|jpe?g|webp|heic)$/i.test(filename)) return;
        const prev = this.pendingShares.get(filename);
        if (prev) window.clearTimeout(prev);
        this.pendingShares.set(
          filename,
          window.setTimeout(() => {
            this.pendingShares.delete(filename);
            this.autoImportShared(filename).catch((error) => console.warn("[course-navigator]", error));
          }, 2000)
        );
      });
    } catch (error) {
      console.warn("[pdf-note] 监听荣耀分享目录失败", error);
    }
  }

  unwatchShareDir() {
    if (this.shareWatcher) {
      try {
        this.shareWatcher.close();
      } catch (error) {
        /* 已关闭 */
      }
      this.shareWatcher = null;
    }
    for (const timer of this.pendingShares.values()) window.clearTimeout(timer);
    this.pendingShares.clear();
  }

  // 手动兜底：路由没接住的，用这条命令挑目标作业记录
  async archiveHandwriting() {
    const shareDir = String(this.settings.shareInboxDir || "").trim();
    if (!shareDir || !fs.existsSync(shareDir)) {
      new Notice(`荣耀分享目录不存在：${shareDir}`);
      return;
    }

    const shots = fs
      .readdirSync(shareDir)
      .filter((name) => /\.(pdf|png|jpe?g|webp|heic)$/i.test(name))
      .map((name) => {
        const abs = path.join(shareDir, name);
        try {
          return { abs, name, time: fs.statSync(abs).ctimeMs };
        } catch (error) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    if (shots.length === 0) {
      new Notice(`荣耀分享目录里没有待归档的文件：${shareDir}`);
      return;
    }

    const workRoot = normalizePath(`${NOTES}/${WORK}`);
    const records = this.app.vault.getMarkdownFiles().filter((f) => f.path.includes(`/${WORK}/`));
    if (records.length === 0) {
      new Notice(`${WORK} 目录下还没有作业记录，先建一篇。`);
      return;
    }

    new MaterialSuggest(this.app, records, async (record) => {
      const targetDir = normalizePath(`${record.parent ? record.parent.path : workRoot}/${record.basename}`);
      if (!(this.app.vault.getAbstractFileByPath(targetDir) instanceof TFolder)) {
        await this.app.vault.createFolder(targetDir);
      }

      let moved = 0;
      let index = 0;
      const nextTarget = (ext) => {
        index += 1;
        let target = normalizePath(`${targetDir}/${record.basename}-p${String(index).padStart(2, "0")}.${ext}`);
        while (this.app.vault.getAbstractFileByPath(target)) {
          index += 1;
          target = normalizePath(`${targetDir}/${record.basename}-p${String(index).padStart(2, "0")}.${ext}`);
        }
        return target;
      };

      for (const shot of shots) {
        const m = shot.name.match(/\.([a-z0-9]+)$/i);
        const ext = (m ? m[1] : "pdf").toLowerCase();
        const target = nextTarget(ext);
        try {
          const data = fs.readFileSync(shot.abs);
          await this.app.vault.createBinary(
            target,
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
          );
          fs.unlinkSync(shot.abs);
          moved += 1;
        } catch (error) {
          console.warn("[pdf-note] 手写件归档失败", shot.name, error);
        }
      }
      new Notice(`已归档 ${moved}/${shots.length} 个手写件到 ${targetDir}`);
      this.activateGroupView?.();
    });
  }

  isLab(pdf) {
    // 判定规则可在设置里配：先看路径里有没有配置的子目录，再看文件名关键词
    const folders = splitList(this.settings.labFolders);
    const keywords = splitList(this.settings.labKeywords);
    const posix = pdf.path.replace(/\\/g, "/");
    if (folders.length && folders.some((f) => posix.includes(`/${MATERIAL}/${f}/`))) return true;
    if (!posix.includes(`/${MATERIAL}/`)) return false;
    return keywords.length > 0 ? new RegExp(keywords.join("|")).test(pdf.basename) : false;
  }

  // 在读/<科目>/材料/… 的笔记统一放 <科目>/产出/笔记/
  notesRoot(pdf) {
    const parts = pdf.path.split("/");
    const index = parts.lastIndexOf(MATERIAL);
    if (index <= 0) return null;
    const notes = normalizePath(`${parts.slice(0, index).join("/")}/${NOTES}`);
    return this.app.vault.getAbstractFileByPath(notes) instanceof TFolder ? notes : null;
  }

  async ensureFolder(path) {
    if (!path) throw new Error("找不到对应的笔记目录");
    if (this.app.vault.getAbstractFileByPath(path) instanceof TFolder) return path;
    await this.app.vault.createFolder(path);
    return path;
  }
}

module.exports = PdfNotePlugin;
