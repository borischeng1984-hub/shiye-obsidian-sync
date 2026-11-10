/*
 * 拾页同步 · Obsidian plugin (desktop + iPhone). Plain CommonJS, no build step.
 * Watches the clipping folder and pushes new/changed notes, plus their images,
 * to a private GitHub repository that the 拾页 PWA pulls from.
 * It only reads notes; it never edits or deletes anything in the vault.
 */
const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, TFile, normalizePath, arrayBufferToBase64 } = require('obsidian');

const DEFAULTS = { repo: '', branch: 'main', token: '', folders: 'Clippings', autoSync: true, synced: {} };
const BATCH = 10;
const MAX_IMAGE = 15 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

const utf8Base64 = text => arrayBufferToBase64(new TextEncoder().encode(text).buffer);
async function hex(buffer, algo = 'SHA-1') {
  const digest = await crypto.subtle.digest(algo, buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Image references in Markdown / HTML / Obsidian embeds, in document order. */
function imageRefs(raw) {
  const refs = new Set();
  for (const m of raw.matchAll(/!\[\[([^\]]+)\]\]/g)) refs.add(m[1].split('|')[0].trim());
  for (const m of raw.matchAll(/!\[[^\]]*\]\(\s*<([^>]+)>[^)]*\)/g)) refs.add(m[1].trim());
  for (const m of raw.matchAll(/!\[[^\]]*\]\(\s*([^)\s<>]+)(?:\s+["'][^)]*["'])?\s*\)/g)) refs.add(m[1].trim());
  for (const m of raw.matchAll(/<img[^>]+?(?:data-src|src)=["']([^"']+)["']/gi)) if (!m[1].startsWith('data:')) refs.add(m[1].replace(/&amp;/g, '&'));
  return [...refs].filter(Boolean);
}

class GitHub {
  constructor(settings) {
    const [owner, repo] = settings.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
    this.owner = owner; this.repo = repo; this.branch = settings.branch || 'main'; this.token = settings.token.trim();
  }
  async call(method, path, body, accept = 'application/vnd.github+json') {
    const res = await requestUrl({
      url: `https://api.github.com/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`,
      method, throw: false, contentType: 'application/json', body: body ? JSON.stringify(body) : undefined,
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (res.status === 401) throw new Error('GitHub 令牌无效或已过期');
    if (res.status === 403) throw new Error('令牌没有这个仓库的写入权限（需要 Contents: Read and write）');
    return res;
  }
  async head() {
    let res = await this.call('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (res.status === 404 || res.status === 409) {
      // Brand-new empty repository: create the first commit through the contents API.
      const init = await this.call('PUT', '/contents/README.md', { message: '初始化拾页同步仓库', branch: this.branch, content: utf8Base64('# 拾页同步仓库\n\n由 Obsidian「拾页同步」插件自动写入。请保持私有。\n') });
      if (init.status === 404) throw new Error('找不到仓库，请检查「用户名/仓库名」');
      if (init.status >= 300) throw new Error(`初始化仓库失败（${init.status}）`);
      res = await this.call('GET', `/git/ref/heads/${encodeURIComponent(this.branch)}`);
    }
    if (res.status !== 200) throw new Error(`读取仓库失败（${res.status}）`);
    return res.json.object.sha;
  }
  async tree(commitSha) {
    const commit = await this.call('GET', `/git/commits/${commitSha}`);
    const treeSha = commit.json.tree.sha;
    const tree = await this.call('GET', `/git/trees/${treeSha}?recursive=1`);
    return { treeSha, paths: new Set((tree.json.tree || []).map(t => t.path)) };
  }
  async readJson(path) {
    // Raw media type works past the 1 MB limit of the JSON contents response.
    const res = await this.call('GET', `/contents/${path}?ref=${encodeURIComponent(this.branch)}`, undefined, 'application/vnd.github.raw+json');
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`读取 ${path} 失败（${res.status}）`);
    return JSON.parse(new TextDecoder().decode(res.arrayBuffer));
  }
  async blob(base64) {
    const res = await this.call('POST', '/git/blobs', { content: base64, encoding: 'base64' });
    if (res.status !== 201) throw new Error(`上传失败（${res.status}）`);
    return res.json.sha;
  }
  async commit(parent, baseTree, entries, message) {
    const tree = await this.call('POST', '/git/trees', { base_tree: baseTree, tree: entries.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })) });
    if (tree.status !== 201) throw new Error(`写入目录失败（${tree.status}）`);
    const commit = await this.call('POST', '/git/commits', { message, tree: tree.json.sha, parents: [parent] });
    if (commit.status !== 201) throw new Error(`提交失败（${commit.status}）`);
    const ref = await this.call('PATCH', `/git/refs/heads/${encodeURIComponent(this.branch)}`, { sha: commit.json.sha });
    if (ref.status === 422) return false; // someone else moved the branch; caller retries
    if (ref.status !== 200) throw new Error(`更新分支失败（${ref.status}）`);
    return true;
  }
}

module.exports = class LeafSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.synced = this.settings.synced || {};
    this.running = false; this.again = false; this.timer = null;
    this.addSettingTab(new LeafSyncSettings(this.app, this));
    this.addCommand({ id: 'sync-now', name: '立即同步到拾页', callback: () => this.sync(true) });
    this.addRibbonIcon('book-open', '同步到拾页', () => this.sync(true));
    const changed = file => { if (file instanceof TFile && this.watched(file)) this.schedule(); };
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      // Keep the same article id so 拾页 updates the existing book instead of adding a copy.
      const old = this.settings.synced[oldPath];
      if (old) { delete this.settings.synced[oldPath]; if (file instanceof TFile && this.watched(file)) this.settings.synced[file.path] = { id: old.id, mtime: -1 }; this.saveData(this.settings); }
      changed(file);
    }));
    this.app.workspace.onLayoutReady(() => this.schedule(4000));
    this.registerInterval(window.setInterval(() => this.sync(false), 15 * 60 * 1000));
  }
  onunload() { clearTimeout(this.timer); }
  configured() { return /^[\w.-]+\/[\w.-]+$/.test(this.settings.repo.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '')) && this.settings.token.trim(); }
  folders() { return this.settings.folders.split(/[,，\n]/).map(f => normalizePath(f.trim())).filter(f => f && f !== '/'); }
  watched(file) {
    if (file.extension !== 'md') return false;
    const folders = this.folders();
    return !folders.length || folders.some(f => file.path === f || file.path.startsWith(f + '/'));
  }
  // Web Clipper writes a note and may touch it again moments later; wait for it to settle.
  schedule(delay = 8000) {
    if (!this.settings.autoSync || !this.configured()) return;
    clearTimeout(this.timer); this.timer = setTimeout(() => this.sync(false), delay);
  }
  async saveSettings() { await this.saveData(this.settings); }

  async loadImage(ref, file) {
    if (/^https?:\/\//i.test(ref)) {
      const url = ref.replace(/^http:\/\//i, 'https://');
      // requestUrl sends no Referer, so WeChat's mmbiz.qpic.cn returns the real picture.
      const res = await requestUrl({ url, method: 'GET', throw: false });
      const type = (res.headers['content-type'] || res.headers['Content-Type'] || '').split(';')[0].trim().toLowerCase();
      if (res.status !== 200 || !type.startsWith('image/')) return null;
      const buf = res.arrayBuffer;
      if (!buf.byteLength || buf.byteLength > MAX_IMAGE) return null;
      const fmt = (url.match(/[?&]wx_fmt=(\w+)/) || [])[1];
      const ext = MIME_EXT[type] || (fmt === 'jpeg' ? 'jpg' : fmt) || 'jpg';
      return { key: ref, buf, ext };
    }
    if (/^[a-z]+:/i.test(ref)) return null;
    let link = ref; try { link = decodeURIComponent(ref); } catch {}
    link = link.split('#')[0].split('?')[0];
    if (!IMAGE_EXT.test(link)) return null;
    const dir = file.parent ? file.parent.path : '';
    let target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
    if (!target) {
      const rel = this.app.vault.getAbstractFileByPath(normalizePath((dir && dir !== '/' ? dir + '/' : '') + link));
      if (rel instanceof TFile) target = rel;
    }
    if (!(target instanceof TFile) || target.stat.size > MAX_IMAGE) return null;
    // 拾页 resolves local images by vault path, the same way it does for imported folders.
    return { key: target.path, buf: await this.app.vault.readBinary(target), ext: target.extension.toLowerCase() };
  }

  async sync(manual) {
    if (!this.configured()) { if (manual) new Notice('拾页同步：请先在插件设置里填写 GitHub 仓库和令牌'); return; }
    if (this.running) { this.again = true; return; }
    this.running = true;
    let pushed = 0, imageMiss = 0;
    try {
      const todo = this.app.vault.getMarkdownFiles().filter(f => this.watched(f) && this.settings.synced[f.path]?.mtime !== f.stat.mtime);
      if (!todo.length) { if (manual) new Notice('拾页同步：没有需要同步的新文章'); return; }
      if (manual || todo.length > 1) new Notice(`拾页同步：正在上传 ${todo.length} 篇…`);
      const gh = new GitHub(this.settings);
      for (let i = 0; i < todo.length; i += BATCH) {
        const result = await this.pushBatch(gh, todo.slice(i, i + BATCH));
        pushed += result.pushed; imageMiss += result.imageMiss;
      }
      new Notice(`拾页同步：已同步 ${pushed} 篇${imageMiss ? `（${imageMiss} 张图片未能下载，拾页会联网加载）` : ''}`);
    } catch (e) {
      console.error('[拾页同步]', e);
      new Notice(`拾页同步失败：${e.message || e}`, 8000);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(2000); }
    }
  }

  async pushBatch(gh, files, attempt = 0) {
    const head = await gh.head();
    const { treeSha, paths } = await gh.tree(head);
    const index = (await gh.readJson('index.json')) || { format: 'leaf-sync', version: 1, articles: {} };
    const entries = [], done = [];
    let imageMiss = 0;
    const put = async (path, base64) => { entries.push({ path, sha: await gh.blob(base64) }); paths.add(path); };
    for (const file of files) {
      const raw = await this.app.vault.cachedRead(file);
      if (!raw.trim()) continue; // Web Clipper may create the file before writing; a later modify retries.
      const id = this.settings.synced[file.path]?.id || (await hex(new TextEncoder().encode(file.path))).slice(0, 20);
      const images = {};
      for (const ref of imageRefs(raw)) {
        let img = null;
        try { img = await this.loadImage(ref, file); } catch (e) { console.warn('[拾页同步] image', ref, e); }
        if (!img) { if (/^https?:\/\//i.test(ref)) imageMiss++; continue; }
        const asset = `assets/${await hex(img.buf)}.${img.ext}`;
        if (!paths.has(asset)) await put(asset, arrayBufferToBase64(img.buf));
        images[img.key] = asset;
      }
      const title = this.app.metadataCache.getFileCache(file)?.frontmatter?.title || file.basename;
      const article = { id, path: file.path, raw, createdAt: file.stat.ctime, updatedAt: file.stat.mtime, images };
      await put(`articles/${id}.json`, utf8Base64(JSON.stringify(article)));
      await put(`notes/${file.path}`, utf8Base64(raw)); // readable Markdown copy for long-term keeping
      index.articles[id] = { path: file.path, title: String(title), updatedAt: file.stat.mtime, file: `articles/${id}.json` };
      done.push([file.path, { id, mtime: file.stat.mtime }]);
    }
    if (!done.length) return { pushed: 0, imageMiss };
    index.updatedAt = Date.now();
    await put('index.json', utf8Base64(JSON.stringify(index, null, 1)));
    const ok = await gh.commit(head, treeSha, entries, `拾页同步：${done.length} 篇`);
    if (!ok) {
      if (attempt >= 2) throw new Error('仓库正被其他设备更新，请稍后再试');
      return this.pushBatch(gh, files, attempt + 1);
    }
    for (const [path, value] of done) this.settings.synced[path] = value;
    await this.saveSettings();
    return { pushed: done.length, imageMiss };
  }
};

class LeafSyncSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; const s = this.plugin.settings;
    containerEl.empty();
    containerEl.createEl('p', { text: '把剪藏文件夹里的文章（连同图片）同步到你的私有 GitHub 仓库，拾页打开时会自动拉取。插件只读取笔记，不会修改或删除仓库里的任何文件。' });
    new Setting(containerEl).setName('GitHub 仓库').setDesc('格式：用户名/仓库名。请使用私有仓库。')
      .addText(t => t.setPlaceholder('boris/shiye-library').setValue(s.repo).onChange(async v => { s.repo = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('可写令牌').setDesc('GitHub 细粒度令牌，只授权这个仓库，权限 Contents: Read and write。')
      .addText(t => { t.inputEl.type = 'password'; t.setPlaceholder('github_pat_…').setValue(s.token).onChange(async v => { s.token = v.trim(); await this.plugin.saveSettings(); }); });
    new Setting(containerEl).setName('同步的文件夹').setDesc('多个用逗号分隔。Web Clipper 默认保存到 Clippings。留空表示整个仓库。')
      .addText(t => t.setPlaceholder('Clippings').setValue(s.folders).onChange(async v => { s.folders = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('自动同步').setDesc('新文章保存后约 8 秒自动上传。')
      .addToggle(t => t.setValue(s.autoSync).onChange(async v => { s.autoSync = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('立即同步').setDesc(`已同步 ${Object.keys(s.synced).length} 篇。`)
      .addButton(b => b.setButtonText('同步').setCta().onClick(() => this.plugin.sync(true)))
      .addButton(b => b.setButtonText('全部重新上传').onClick(async () => {
        if (!confirm('重新上传文件夹里的全部文章？拾页里的阅读进度和批注不受影响。')) return;
        for (const k of Object.keys(s.synced)) s.synced[k] = { id: s.synced[k].id, mtime: -1 };
        await this.plugin.saveSettings(); this.plugin.sync(true); this.display();
      }));
  }
}

module.exports.imageRefs = imageRefs;
