(function () {
  "use strict";

// 查找 ZIP 末尾的 EOCD 目录记录。
function findEocd(view, length) {
  const minOffset = Math.max(0, length - 65557);

  for (let offset = length - 22; offset >= minOffset; offset--) {
    if (view.getUint32(offset, true) !== 0x06054b50) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + 22 + commentLength === length) return offset;
  }

  throw new Error("不是有效的 EPUB：找不到 ZIP 目录");
}

// 读取一条中央目录记录及其本地数据位置。
function readCentralEntry(view, bytes, offset, decoder) {
  if (view.getUint32(offset, true) !== 0x02014b50) {
    throw new Error("ZIP 中央目录损坏");
  }
  const method = view.getUint16(offset + 10, true);
  const compressedSize = view.getUint32(offset + 20, true);
  const uncompressedSize = view.getUint32(offset + 24, true);
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const localOffset = view.getUint32(offset + 42, true);
  const name = decoder.decode(
    bytes.subarray(offset + 46, offset + 46 + nameLength)
  );
  if (view.getUint32(localOffset, true) !== 0x04034b50) {
    throw new Error(`ZIP 本地文件头损坏：${name}`);
  }
  const localNameLength = view.getUint16(localOffset + 26, true);
  const localExtraLength = view.getUint16(localOffset + 28, true);
  return {
    name,
    nextOffset: offset + 46 + nameLength + extraLength + commentLength,
    entry: {
      method,
      compressedSize,
      uncompressedSize,
      dataOffset: localOffset + 30 + localNameLength + localExtraLength,
    },
  };
}

// 读取中央目录并建立文件索引。
function readZipDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocd(view, bytes.length);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const entries = new Map();
  const decoder = new TextDecoder("utf-8");
  let offset = view.getUint32(eocdOffset + 16, true);

  for (let index = 0; index < entryCount; index++) {
    const record = readCentralEntry(view, bytes, offset, decoder);
    entries.set(record.name, record.entry);
    offset = record.nextOffset;
  }

  return entries;
}

// 按目录记录解压单个 ZIP 文件。
async function readEntryBytes(bytes, entries, path) {
  const entry = entries.get(path);
  if (!entry) throw new Error(`EPUB 缺少文件：${path}`);
  const compressed = bytes.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize
  );
  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) {
    throw new Error(`不支持的 ZIP 压缩方法：${entry.method}`);
  }

  const stream = new Blob([compressed])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 读取并解码 UTF-8 文本条目。
async function readTextEntry(bytes, entries, path) {
  const data = await readEntryBytes(bytes, entries, path);
  return new TextDecoder("utf-8").decode(data);
}

// 解析 XML 并在解析失败时抛出错误。
function parseXml(text, source) {
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error(`XML 解析失败：${source}`);
  }
  return document;
}

// 读取指定 Dublin Core 元数据值。
function readDcValue(document, name) {
  const namespace = "http://purl.org/dc/elements/1.1/";
  const node = document.getElementsByTagNameNS(namespace, name)[0];
  return node?.textContent?.trim() ?? "";
}

// 读取 container.xml 指定的 OPF 文档。
async function readPackageDocuments(bytes, entries) {
  const containerText = await readTextEntry(
    bytes,
    entries,
    "META-INF/container.xml"
  );
  const container = parseXml(containerText, "META-INF/container.xml");
  const rootfile = container.getElementsByTagName("rootfile")[0];
  if (!rootfile) throw new Error("EPUB 缺少 rootfile");

  const opfPath = rootfile.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB 的 rootfile 缺少 full-path");
  const opf = parseXml(await readTextEntry(bytes, entries, opfPath), opfPath);
  const slashIndex = opfPath.lastIndexOf("/");
  const opfDir = slashIndex < 0 ? "" : opfPath.slice(0, slashIndex + 1);
  return { opf, opfDir };
}

// 读取 OPF manifest 的全部条目。
function readManifest(opf) {
  return Array.from(opf.getElementsByTagName("item"), (item) => ({
    id: item.getAttribute("id") ?? "",
    href: item.getAttribute("href") ?? "",
    type: item.getAttribute("media-type") ?? "",
    props: item.getAttribute("properties") ?? "",
  }));
}

// 读取 OPF spine 的阅读顺序。
function readSpine(opf) {
  return Array.from(
    opf.getElementsByTagName("itemref"),
    (item) => item.getAttribute("idref") ?? ""
  );
}

// 去掉链接里的片段标识。
function stripHash(href) {
  return String(href ?? "").split("#")[0];
}

// 获取 POSIX 路径所在的目录。
function dirnamePosix(path) {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex < 0 ? "" : path.slice(0, slashIndex + 1);
}

// 拼接并规范化 POSIX 路径。
function joinPosix(baseDir, relative) {
  const source = `${baseDir}${String(relative ?? "").replace(/^\//, "")}`;
  const parts = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

// 把元素文本规范成单行标题。
function elementText(element) {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

// 从 nav.xhtml 提取章节标题。
async function readNavTitles(bytes, entries, opfDir, navItem) {
  const titles = new Map();
  if (!navItem) return titles;
  const navPath = joinPosix(opfDir, stripHash(navItem.href));
  const navDir = dirnamePosix(navPath);
  const document = parseXml(
    await readTextEntry(bytes, entries, navPath),
    navPath
  );
  for (const anchor of document.getElementsByTagName("a")) {
    const href = stripHash(anchor.getAttribute("href"));
    const title = elementText(anchor);
    if (href && title) titles.set(joinPosix(navDir, href), title);
  }
  return titles;
}

// 从 toc.ncx 提取章节标题。
async function readNcxTitles(bytes, entries, opfDir, ncxItem) {
  const titles = new Map();
  if (!ncxItem) return titles;
  const ncxPath = joinPosix(opfDir, stripHash(ncxItem.href));
  const ncxDir = dirnamePosix(ncxPath);
  const document = parseXml(
    await readTextEntry(bytes, entries, ncxPath),
    ncxPath
  );
  for (const point of document.getElementsByTagName("navPoint")) {
    const content = point.getElementsByTagName("content")[0];
    const label = point
      .getElementsByTagName("navLabel")[0]
      ?.getElementsByTagName("text")[0];
    const href = stripHash(content?.getAttribute("src"));
    const title = elementText(label);
    if (href && title) titles.set(joinPosix(ncxDir, href), title);
  }
  return titles;
}

// 合并 nav 和 NCX 标题并保持 nav 优先。
async function readTocTitles(bytes, entries, opfDir, manifest) {
  const titles = new Map();
  const navItem =
    manifest.find((item) => item.props.split(/\s+/).includes("nav")) ??
    manifest.find((item) => stripHash(item.href).endsWith("nav.xhtml"));
  const ncxItem = manifest.find(
    (item) =>
      item.type === "application/x-dtbncx+xml" ||
      stripHash(item.href).toLowerCase().endsWith(".ncx")
  );
  const navTitles = await readNavTitles(bytes, entries, opfDir, navItem);
  const ncxTitles = await readNcxTitles(bytes, entries, opfDir, ncxItem);
  for (const [path, title] of navTitles) titles.set(path, title);
  for (const [path, title] of ncxTitles) {
    if (!titles.has(path)) titles.set(path, title);
  }
  return titles;
}

// 把章节 HTML 里的资源引用改写成「相对 opfDir」的路径。
function rewriteResourcePaths(html, chapterHref) {
  const chapterDir = dirnamePosix(chapterHref);
  const resolve = (value) => {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    // 不处理外链、data:、已是绝对 URL 的
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return raw;
    // 开头的 / 指 zip 根，不是章节所在目录，去掉斜杠后不能再拼 chapterDir。
    if (raw.startsWith("/")) return joinPosix("", raw.replace(/^\/+/, ""));
    return joinPosix(chapterDir, raw);
  };

  // 用 DOMParser 当 html 解析（不是 xml），宽容度更高
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    "text/html"
  );
  for (const img of doc.querySelectorAll("img[src]")) {
    img.setAttribute("src", resolve(img.getAttribute("src")));
  }
  // SVG 里的图片是 <image xlink:href>，必须单独处理，否则只显示空白
  for (const image of doc.querySelectorAll("image")) {
    const href = image.getAttribute("xlink:href") ?? image.getAttribute("href");
    if (href) {
      image.setAttribute("xlink:href", resolve(href));
      image.setAttribute("href", resolve(href));
    }
  }
  // 去掉 srcset（多数阅读器无法可靠处理多分辨率，先不管）
  for (const el of doc.querySelectorAll("[srcset]")) {
    el.removeAttribute("srcset");
  }
  return doc.body.innerHTML;
}

// 读取章节正文并生成兜底标题。
// href 是相对 opfDir 的路径，内部拼成相对 zip 根的 path。
async function readChapterContent(bytes, entries, opfDir, href, index) {
  const path = joinPosix(opfDir, href);
  const document = parseXml(
    await readTextEntry(bytes, entries, path),
    path
  );
  const body = document.getElementsByTagName("body")[0];
  // 原始 HTML 用来渲染；资源路径改写成相对 opfDir。
  const html = rewriteResourcePaths(body?.innerHTML ?? "", href);
  // 保留分段：每行内部压缩空白，行首尾去掉，丢弃空行，行间用 \n 连接。
  // setReadingText 按 \n 切段，正好对上。
  const rawText = body?.textContent ?? "";
  const text = rawText
    .split(/\r?\n/)
    .map((line) => line.replace(/[\s\u3000]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
  // 字数统计要的是不含空白的字数，与显示用的 text 区分开。
  const charCount = text.replace(/[\s\u3000]/g, "").length;
  const heading = elementText(document.getElementsByTagName("h1")[0]);
  const pageTitle = elementText(document.getElementsByTagName("title")[0]);
  return {
    html,
    text,
    charCount,
    fallbackTitle: heading || pageTitle || `第 ${index + 1} 章`,
  };
}

// 严格按 spine 顺序读取全部章节正文。
async function getChapters(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(bytes);
  const { opf, opfDir } = await readPackageDocuments(bytes, entries);
  const manifest = readManifest(opf);
  const manifestById = new Map(manifest.map((item) => [item.id, item]));
  const spineIds = readSpine(opf);
  const titles = await readTocTitles(bytes, entries, opfDir, manifest);
  const chapters = [];
  let chars = 0;
  for (let index = 0; index < spineIds.length; index++) {
    const item = manifestById.get(spineIds[index]);
    if (!item) throw new Error(`spine 缺少 manifest 项：${spineIds[index]}`);
    const href = stripHash(item.href);
    const path = joinPosix(opfDir, href);
    const content = await readChapterContent(
      bytes,
      entries,
      opfDir,
      href,
      index
    );
    chapters.push({
      title: titles.get(path) || content.fallbackTitle,
      href,
      html: content.html,
      text: content.text,
      chars: content.charCount,
    });
    chars += content.charCount;
  }
  return { chapters, chars };
}

// 按三级规则查找封面清单项。
function findCoverItem(opf, manifest) {
  const propertyCover = manifest.find((item) =>
    item.props.split(/\s+/).includes("cover-image")
  );
  if (propertyCover) return propertyCover;

  const coverId = Array.from(opf.getElementsByTagName("meta")).find(
    (meta) => meta.getAttribute("name")?.toLowerCase() === "cover"
  )?.getAttribute("content");
  const metaCover = manifest.find((item) => item.id === coverId);
  if (metaCover) return metaCover;

  return manifest.find((item) => {
    const searchText = `${item.id} ${item.href}`.toLowerCase();
    return searchText.includes("cover") && item.type.toLowerCase().startsWith("image/");
  }) ?? null;
}

// 读取 EPUB 封面图片并返回 Blob。
async function getCover(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(bytes);
  const { opf, opfDir } = await readPackageDocuments(bytes, entries);
  const item = findCoverItem(opf, readManifest(opf));
  if (!item) return null;
  const path = joinPosix(opfDir, stripHash(item.href));
  const data = await readEntryBytes(bytes, entries, path);
  return { blob: new Blob([data], { type: item.type }), mediaType: item.type };
}

// 读取 manifest 里的全部图片。
// 用 manifest 而不是扫 html 找引用：src 可能藏在 CSS 的 url()、SVG 的 <image>
// 甚至 @import 的样式表里，逐个 grep 一定会漏。
async function getAllImages(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(bytes);
  const { opf, opfDir } = await readPackageDocuments(bytes, entries);
  const images = [];
  for (const item of readManifest(opf)) {
    if (!item.type.toLowerCase().startsWith("image/")) continue;
    const path = joinPosix(opfDir, stripHash(item.href));
    if (!entries.has(path)) continue; // manifest 里有但 zip 里没有，跳过别抛
    const data = await readEntryBytes(bytes, entries, path);
    images.push({
      path: stripHash(item.href), // 相对 opfDir，跟 html 里的 src 对上
      mediaType: item.type,
      blob: new Blob([data], { type: item.type }),
    });
  }
  return images;
}

// 判断 manifest 项是否为字体资源。
function isFontAsset(item, href) {
  const type = item.type.toLowerCase();
  const path = stripHash(href).split("?")[0].toLowerCase();
  return type.startsWith("font/") || type.includes("font") ||
    /\.(?:ttf|otf|woff2?)$/.test(path);
}

// 读取 manifest 中的 CSS 和字体资源。
async function getAssets(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(bytes);
  const { opf, opfDir } = await readPackageDocuments(bytes, entries);
  const css = [];
  const fonts = [];
  for (const item of readManifest(opf)) {
    const href = stripHash(item.href);
    const path = joinPosix(opfDir, href);
    if (item.type.toLowerCase() === "text/css") {
      css.push({ href, text: await readTextEntry(bytes, entries, path) });
    } else if (isFontAsset(item, href)) {
      const data = await readEntryBytes(bytes, entries, path);
      fonts.push({
        href,
        mediaType: item.type,
        blob: new Blob([data], { type: item.type }),
      });
    }
  }
  return { css, fonts };
}

// 删除 CSS 注释，避免误改注释内容。
function stripCssComments(cssText) {
  return String(cssText ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
}

// 把 html 和 body 选择器改写到书页根节点。
function rewriteCssSelectors(cssText) {
  return cssText.replace(/([^{}]+)\{/g, (match, prelude) => {
    if (prelude.trimStart().startsWith("@")) return match;
    const scoped = prelude.replace(
      /(^|[\s>+~,(])(html|body)(?=$|[\s>+~),.#:\[])/gi,
      "$1.book-body"
    );
    return `${scoped}{`;
  });
}

// 将 CSS 中的所有 url() 路径交给调用方解析。
function replaceCssUrls(cssText, resolveUrl) {
  return cssText.replace(
    /url\(\s*(['"]?)(.*?)\1\s*\)/gi,
    (_match, quote, value) => `url(${quote}${resolveUrl(value.trim())}${quote})`
  );
}

// 生成可安全注入 Shadow DOM 的 CSS 文本。
function scopeCss(cssText, resolveUrl) {
  const withoutComments = stripCssComments(cssText);
  return replaceCssUrls(rewriteCssSelectors(withoutComments), resolveUrl);
}

// 在 Shadow DOM 中渲染章节内容。
function renderChapter(container, chapterHtml, scopedCss) {
  const shadowRoot =
    container.shadowRoot ?? container.attachShadow({ mode: "open" });
  shadowRoot.innerHTML = `
    <style>${scopedCss}</style>
    <style>
      :host { display:block; padding:16px; }
      .book-body { font-size: var(--reader-font-size, 18px); color: var(--reader-color, #333); }
      .book-body img { max-width:100%; height:auto; }
      /* 书的 CSS 常把字号/颜色硬编码到 p、div 等子元素上（如 p { font-size:12px;
         color:#000 }），只设 .book-body 压不住，暗色模式下会变成黑字看不清。
         字号和颜色是用户直接控制的，用 !important 兜底；行高跟着字号走。 */
      .book-body,
      .book-body p,
      .book-body div,
      .book-body li,
      .book-body span {
        font-size: var(--reader-font-size, 18px) !important;
        color: var(--reader-color, #333) !important;
      }
      .book-body { line-height: 1.8 !important; }
    </style>
    <div class="book-body">${chapterHtml}</div>
  `;
  return shadowRoot;
}

// 解包 EPUB 并返回包清单元数据。
async function inspectEpub(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZipDirectory(bytes);
  const { opf, opfDir } = await readPackageDocuments(bytes, entries);

  return {
    ok: true,
    title: readDcValue(opf, "title"),
    author: readDcValue(opf, "creator"),
    opfDir,
    items: readManifest(opf),
    spine: readSpine(opf),
  };
}

window.NovelEpub = {
  inspectEpub,
  getChapters,
  getCover,
  getAllImages,
  getAssets,
  scopeCss,
  renderChapter,
  rewriteResourcePaths,
  joinPosix,
  dirnamePosix,
};
})();
