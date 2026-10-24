/**
 * 微信公众号排版工作台 (WeChat-MD Studio · Claude UI Edition v3.0)
 * 核心前端逻辑：
 * 1. 6套科研与人文公众号主题定义（100% 内联 style 模板生成器，完美兼容微信公众号编辑器）
 * 2. Markdown-it + Highlight.js + MathJax 3 (SVG) 公式无损转换
 * 3. 本地图片路径 (E:/... 或 ./figures/...) 自动映射与 Base64/微信素材库直传
 * 4. 外链自动转文末参考文献角标 [1] 与图注自动美化 (▲ 图 X)
 *
 * v3.0 优化：
 * - 代码块/行内代码中的 $ 不再被误识别为公式（R 语言 df$col、Shell $PATH 等）
 * - 公式 SVG 与代码高亮结果缓存，大文档输入不卡顿；代码高亮转为内联颜色，粘贴到微信后不丢色
 * - 设置、草稿、微信图床 URL 持久化到 localStorage；未保存提示；外部修改冲突检测
 * - 支持粘贴/拖拽图片、拖拽 .md 文件；Tab 缩进；Ctrl+B / Ctrl+I 快捷键
 * - 复制/导出共用图片内联流程（并发压缩 + 缓存）；导出 HTML 图片离线可用
 */

const THEMES = {
  "bioinfo-blue": {
    name: "经典科研蓝",
    primary: "#1A56DB",
    softBg: "#EFF6FF",
    quoteBg: "#F4F8FD",
    quoteBorder: "#1A56DB",
    codeBg: "#1E222A",
    h2Style: (c, soft) =>
      `margin: 30px 0 16px; padding: 8px 14px; border-left: 4px solid ${c}; background: linear-gradient(90deg, ${soft} 0%, rgba(255,255,255,0) 100%); font-size: 17px; font-weight: 700; color: #111827; line-height: 1.45; letter-spacing: 0.02em; border-radius: 0 6px 6px 0;`
  },
  "claude-terracotta": {
    name: "Claude · 温暖人文陶土",
    primary: "#D97757",
    softBg: "#FAF0EC",
    quoteBg: "#FAF7F2",
    quoteBorder: "#D97757",
    codeBg: "#232220",
    h2Style: (c, soft) =>
      `margin: 30px 0 16px; padding: 6px 0 9px; border-bottom: 2px solid ${c}; font-family: Georgia, "Songti SC", "Noto Serif SC", serif; font-size: 18px; font-weight: 700; color: #141413; line-height: 1.45;`
  },
  "nature-emerald": {
    name: "Cell / Nature · 翡翠学术绿",
    primary: "#0D7A5F",
    softBg: "#ECFDF5",
    quoteBg: "#F2FBF7",
    quoteBorder: "#0D7A5F",
    codeBg: "#1B2420",
    h2Style: (c, soft) =>
      `margin: 30px 0 16px; display: inline-block; padding: 6px 16px; background-color: ${c}; color: #FFFFFF; font-size: 16px; font-weight: 700; border-radius: 999px; box-shadow: 0 2px 6px rgba(13,122,95,0.22);`
  },
  "ai-violet": {
    name: "前沿 AI · 极客紫",
    primary: "#6D28D9",
    softBg: "#F5F3FF",
    quoteBg: "#F8F6FF",
    quoteBorder: "#6D28D9",
    codeBg: "#1A1826",
    h2Style: (c, soft) =>
      `margin: 30px 0 16px; padding: 8px 14px; border-left: 4px solid ${c}; background-color: ${soft}; font-size: 17px; font-weight: 700; color: ${c}; border-radius: 6px;`
  },
  "cns-crimson": {
    name: "CNS 重磅 · 学术红",
    primary: "#B91C1C",
    softBg: "#FEF2F2",
    quoteBg: "#FFF8F8",
    quoteBorder: "#B91C1C",
    codeBg: "#241C1C",
    h2Style: (c, soft) =>
      `margin: 30px 0 16px; padding: 7px 14px; border-left: 5px solid ${c}; border-bottom: 1px solid ${soft}; font-size: 17px; font-weight: 700; color: #7F1D1D; background-color: ${soft};`
  },
  "minimal-ink": {
    name: "极简墨韵 · 深度阅读",
    primary: "#27272A",
    softBg: "#F4F4F5",
    quoteBg: "#F9FAFB",
    quoteBorder: "#3F3F46",
    codeBg: "#18181B",
    h2Style: (c, soft) =>
      `margin: 32px 0 16px; padding-left: 12px; border-left: 3px solid ${c}; font-size: 17px; font-weight: 700; color: #18181B; letter-spacing: 0.03em;`
  }
};

// ======================= 全局状态与持久化 =======================
const STORAGE_KEYS = {
  settings: "wxmd.settings.v3.1",
  wechatUrls: "wxmd.wechatUrls.v3",
  draft: "wxmd.draft.v3"
};

const DEFAULT_SETTINGS = {
  themeKey: "bioinfo-blue",
  primaryColor: "#1A56DB",
  fontSize: "15px",
  lineHeight: "1.85",
  autoCaption: true,
  footnoteLinks: true,
  macCode: true,
  inlineBase64: true,
  device: "desktop",
  mode: "light",
  sidebarCollapsed: false,
  lastFile: "",
  accountName: "公众号名称",
  location: "发表于浙江",
  showOrigTag: true,
  splitRatio: 50,
  appId: ""
};

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v === "object" ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn("localStorage 写入失败：", e);
  }
}

const state = {
  ...DEFAULT_SETTINGS,
  ...loadJSON(STORAGE_KEYS.settings, {}),
  currentFilePath: "",
  currentFileName: "",
  currentFileMtime: null,
  pendingNewName: "", // 导入/新建文档在首次保存时使用的文件名
  customTitle: "", // 用户在预览区手动填写的标题（当正文无 # 一级标题时生效）
  currentBaseDir: "",
  workspaceDir: "",
  savedContent: "", // 最近一次加载/保存的内容，用于判断是否有未保存修改
  uploadedWechatUrls: loadJSON(STORAGE_KEYS.wechatUrls, {}) // key: baseDir|src -> mmbiz URL
};

function persistSettings() {
  const out = {};
  Object.keys(DEFAULT_SETTINGS).forEach((k) => (out[k] = state[k]));
  saveJSON(STORAGE_KEYS.settings, out);
}

// 初始化 markdown-it（CDN 加载失败时给出明确提示而非白屏）
const md = window.markdownit
  ? window.markdownit({ html: true, linkify: true, typographer: false })
  : null;

// ======================= 通用工具函数 =======================
const $id = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 根据主色生成浅色背景
function hexToRgba(hex, alpha = 0.08) {
  let c = String(hex || "#000").replace("#", "");
  if (c.length === 3) c = c.split("").map((x) => x + x).join("");
  const num = parseInt(c, 16) || 0;
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

// 判断是否为本地磁盘图片路径或相对路径
function isLocalImagePath(src) {
  if (!src) return false;
  if (/^(https?:)?\/\//i.test(src) || /^(data|blob):/i.test(src)) return false;
  if (src.startsWith("/api/local-image")) return false;
  return true;
}

// 微信图床 URL 映射键：同名相对路径在不同目录下可能指向不同图片，因此带上 baseDir
function wechatKey(src, baseDir = state.currentBaseDir) {
  return `${baseDir || ""}|${src}`;
}

function getWechatUrl(src) {
  return state.uploadedWechatUrls[wechatKey(src)] || "";
}

function toLocalImageUrl(src) {
  const wx = getWechatUrl(src);
  if (wx) return wx;
  if (!isLocalImagePath(src)) return src;
  return `/api/local-image?path=${encodeURIComponent(src)}&baseDir=${encodeURIComponent(state.currentBaseDir || "")}`;
}

// 简易容量受限缓存
function createCache(limit) {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v);
      return v;
    },
    set(k, v) {
      map.set(k, v);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
    clear() {
      map.clear();
    }
  };
}

const mathCache = createCache(500);
const highlightCache = createCache(200);
const base64Cache = createCache(100);

// ======================= 公式与代码保护 =======================
/**
 * 先把代码块/行内代码替换为占位符（避免其中的 $ 被当作公式），
 * 再提取公式为占位符（防止 markdown-it 把公式里的 _ 或 * 当成斜体），最后还原代码交给 markdown-it。
 */
function protectMathBlocks(rawMd) {
  const codeStore = [];
  const keepCode = (m) => {
    codeStore.push(m);
    return `\u0001CODE${codeStore.length - 1}\u0001`;
  };
  // 围栏代码块（含未闭合至文末的情况）与行内代码
  let text = rawMd.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n(?:[\s\S]*?\n)?? {0,3}\1[`~]*[ \t]*$|^ {0,3}(?:`{3,}|~{3,})[^\n]*\n[\s\S]*(?![\s\S])/gm,
    keepCode
  );
  text = text.replace(/(?<!`)(`+)(?!`)([^\n]*?[^`\n])\1(?!`)/g, keepCode);

  const mathStore = [];
  const keepMath = (tex, display) => {
    const id = `%%MATH${mathStore.length}%%`;
    mathStore.push({ id, tex: tex.trim(), display });
    return id;
  };
  // 块级公式 $$...$$ 与 \[...\]
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => keepMath(tex, true));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => keepMath(tex, true));
  // 行内公式 $...$：开头 $ 后不能是空白、结尾 $ 前不能是空白且后面不能紧跟数字（避免 "$5 和 $10" 误判）
  text = text.replace(/(^|[^\\$])\$(?=\S)([^$\n]*?[^\s\\])\$(?!\d)/g, (_, pre, tex) => pre + keepMath(tex, false));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keepMath(tex, false));

  // 还原代码
  text = text.replace(/\u0001CODE(\d+)\u0001/g, (_, i) => codeStore[+i]);
  return { protectedText: text, mathStore };
}

function mathJaxReady() {
  return !!(window.MathJax && window.MathJax.tex2svg);
}

// 将 MathJax TeX 字符串同步转换为微信兼容的内联 SVG HTML（结果缓存）
function renderTexToSvg(tex, display) {
  const key = `${display ? "D" : "I"}:${tex}`;
  const cached = mathCache.get(key);
  if (cached) return cached;

  if (mathJaxReady()) {
    try {
      const node = window.MathJax.tex2svg(tex, { display });
      const svg = node.querySelector("svg");
      if (svg) {
        svg.style.verticalAlign = display ? "middle" : svg.style.verticalAlign || "-0.18ex";
        svg.style.maxWidth = "100%";
        const out = display
          ? `<section style="margin: 16px 0; text-align: center; overflow-x: auto;">${svg.outerHTML}</section>`
          : `<span style="display: inline-block; margin: 0 2px;">${svg.outerHTML}</span>`;
        mathCache.set(key, out); // 仅缓存成功结果，MathJax 就绪后会重新渲染降级内容
        return out;
      }
    } catch (e) {
      console.warn("MathJax render error:", e);
    }
  }
  const safe = escapeHtml(tex);
  return display
    ? `<pre style="text-align:center;">$$${safe}$$</pre>`
    : `<code>$${safe}$</code>`;
}

// ======================= 代码高亮（内联颜色版） =======================
// atom-one-dark 配色映射：微信编辑器会丢弃 class 样式，因此把高亮颜色写入内联 style
const HLJS_COLORS = {
  keyword: "#C678DD", "selector-tag": "#C678DD", deletion: "#C678DD", doctag: "#C678DD", formula: "#C678DD",
  comment: "#7F848E", quote: "#7F848E",
  string: "#98C379", regexp: "#98C379", addition: "#98C379", attribute: "#98C379", "meta-string": "#98C379",
  number: "#D19A66", literal: "#56B6C2", variable: "#D19A66", "template-variable": "#D19A66", type: "#D19A66",
  "selector-class": "#D19A66", "selector-attr": "#D19A66", "selector-pseudo": "#D19A66", attr: "#D19A66",
  built_in: "#E6C07B", "title.class": "#E6C07B", "class": "#E6C07B",
  title: "#61AEEF", "title.function": "#61AEEF", function: "#61AEEF", symbol: "#61AEEF", bullet: "#61AEEF",
  link: "#61AEEF", meta: "#61AEEF", "selector-id": "#61AEEF",
  name: "#E06C75", tag: "#E06C75", section: "#E06C75", subst: "#E06C75", params: "#ABB2BF"
};

function inlineHljsColors(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  tpl.content.querySelectorAll("span[class]").forEach((span) => {
    const classes = span.className.split(/\s+/).map((c) => c.replace(/^hljs-/, "")).filter(Boolean);
    const compound = classes.join(".");
    const color = HLJS_COLORS[compound] || classes.map((c) => HLJS_COLORS[c]).find(Boolean);
    const styles = [];
    if (color) styles.push(`color: ${color}`);
    if (classes.includes("comment") || classes.includes("quote")) styles.push("font-style: italic");
    if (styles.length) span.setAttribute("style", styles.join("; "));
    span.removeAttribute("class");
  });
  return tpl.innerHTML;
}

function highlightCode(rawCode, lang) {
  const key = `${lang}\u0000${rawCode}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;

  let out = escapeHtml(rawCode);
  if (window.hljs) {
    try {
      if (lang && window.hljs.getLanguage(lang)) {
        out = window.hljs.highlight(rawCode, { language: lang, ignoreIllegals: true }).value;
      } else if (rawCode.length < 20000) {
        // 未声明语言时自动识别（超长代码跳过以免卡顿）
        out = window.hljs.highlightAuto(rawCode).value;
      }
      out = inlineHljsColors(out);
    } catch (_) {}
  }
  highlightCache.set(key, out);
  return out;
}

// ======================= 核心渲染：Markdown → 100% 内联 style 富文本 =======================
function renderWechatArticle(rawMarkdown) {
  const theme = THEMES[state.themeKey] || THEMES["bioinfo-blue"];
  const c = state.primaryColor || theme.primary;
  const soft = hexToRgba(c, 0.08);
  const fs = state.fontSize;
  const lh = state.lineHeight;

  // 提取第一行 # 标题作为微信公众号模拟标题，并从正文移除（公众号有专门标题栏）
  let title = "";
  let bodyMd = rawMarkdown;
  const h1Match = rawMarkdown.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)/);
  if (h1Match) {
    title = h1Match[1].trim();
    bodyMd = rawMarkdown.slice(h1Match[0].length);
  }

  // 1. 保护代码与数学公式 → 2. markdown-it 渲染
  const { protectedText, mathStore } = protectMathBlocks(bodyMd);
  let html = md.render(protectedText);

  // 3. 还原公式为自包含内联 SVG（独占一段的块级公式直接替换 <p>，避免 p 内嵌 section）
  for (const item of mathStore) {
    const svgHtml = renderTexToSvg(item.tex, item.display);
    if (item.display) html = html.split(`<p>${item.id}</p>`).join(svgHtml);
    html = html.split(item.id).join(svgHtml);
  }

  // 4. 使用 DOMParser 对每个标签施加微信公众号 100% 内联 CSS 样式
  const doc = new DOMParser().parseFromString(`<div id="wx-wrapper">${html}</div>`, "text/html");
  const root = doc.getElementById("wx-wrapper");
  const setStyle = (selector, style) => root.querySelectorAll(selector).forEach((el) => el.setAttribute("style", style));

  // 外链转文末参考文献角标
  const footnotes = [];
  root.querySelectorAll("a").forEach((a) => {
    const href = a.getAttribute("href") || "";
    const text = a.textContent.trim();
    if (state.footnoteLinks && /^https?:\/\//i.test(href) && !href.includes("mp.weixin.qq.com")) {
      let idx = footnotes.findIndex((f) => f.href === href);
      if (idx === -1) {
        footnotes.push({ text: text && text !== href ? text : "外部参考链接", href });
        idx = footnotes.length - 1;
      }
      a.setAttribute("style", `color: ${c}; text-decoration: none; font-weight: 500; border-bottom: 1px dashed ${c};`);
      const sup = doc.createElement("sup");
      sup.setAttribute("style", `color: ${c}; font-size: 11px; font-weight: 700; margin-left: 2px;`);
      sup.textContent = `[${idx + 1}]`;
      a.after(sup);
    } else {
      a.setAttribute("style", `color: ${c}; text-decoration: none; border-bottom: 1px solid ${c};`);
    }
  });

  // 标题 H1 ~ H4
  setStyle("h1", `margin: 28px 0 16px; font-size: 19px; font-weight: 700; color: ${c}; text-align: center; line-height: 1.45;`);
  root.querySelectorAll("h2").forEach((el) => {
    const sec = doc.createElement("section");
    sec.setAttribute("style", theme.h2Style(c, soft));
    sec.innerHTML = el.innerHTML;
    el.replaceWith(sec);
  });
  setStyle("h3", `margin: 22px 0 10px; padding-left: 10px; border-left: 3px solid ${c}; font-size: 16px; font-weight: 700; color: #1F2937; line-height: 1.5;`);
  setStyle("h4, h5, h6", `margin: 16px 0 8px; font-size: ${fs}; font-weight: 700; color: ${c}; line-height: 1.5;`);

  // 段落
  setStyle("p", `margin: 0 0 14px; font-size: ${fs}; line-height: ${lh}; color: #2C2C2A; text-align: justify; letter-spacing: 0.02em; word-break: break-word;`);

  // 引用块（导读框 / 结论框）
  root.querySelectorAll("blockquote").forEach((el) => {
    el.setAttribute(
      "style",
      `margin: 18px 0; padding: 14px 16px; background-color: ${soft}; border-left: 4px solid ${c}; border-radius: 0 8px 8px 0; color: #374151; font-size: 14px; line-height: 1.75;`
    );
    const ps = el.querySelectorAll(":scope > p");
    ps.forEach((p, i) => {
      p.setAttribute(
        "style",
        `margin: ${i === ps.length - 1 ? "0" : "0 0 10px"}; font-size: 14px; line-height: 1.75; color: #374151; text-align: justify;`
      );
    });
  });

  // 加粗、斜体、删除线与行内代码
  setStyle("strong", `font-weight: 700; color: ${c};`);
  setStyle("em", "font-style: italic;");
  setStyle("s, del", "text-decoration: line-through; color: #9CA3AF;");
  root.querySelectorAll("code").forEach((el) => {
    if (el.parentElement && el.parentElement.tagName === "PRE") return;
    el.setAttribute(
      "style",
      `padding: 2px 5px; margin: 0 2px; background-color: ${soft}; color: ${c}; border-radius: 4px; font-family: Consolas, Monaco, monospace; font-size: 0.9em; word-break: break-all;`
    );
  });

  // 代码块（按声明语言高亮 + Mac 装饰顶栏）
  const macHeader = state.macCode
    ? `<section style="display: flex; align-items: center; gap: 6px; padding: 9px 14px; background-color: #16181D; border-bottom: 1px solid #2B303B; border-radius: 8px 8px 0 0;"><span style="width: 10px; height: 10px; border-radius: 50%; background-color: #FF5F56; display: inline-block;"></span><span style="width: 10px; height: 10px; border-radius: 50%; background-color: #FFBD2E; display: inline-block;"></span><span style="width: 10px; height: 10px; border-radius: 50%; background-color: #27C93F; display: inline-block;"></span></section>`
    : "";
  root.querySelectorAll("pre").forEach((pre) => {
    const codeEl = pre.querySelector("code");
    const rawCode = (codeEl ? codeEl.textContent : pre.textContent).replace(/\n$/, "");
    const langMatch = codeEl && (codeEl.className || "").match(/language-([\w+#-]+)/);
    const highlighted = highlightCode(rawCode, langMatch ? langMatch[1].toLowerCase() : "");

    const wrapper = doc.createElement("section");
    wrapper.setAttribute(
      "style",
      `margin: 18px 0; border-radius: 8px; overflow: hidden; background-color: ${theme.codeBg}; box-shadow: 0 3px 10px rgba(0,0,0,0.1);`
    );
    wrapper.innerHTML = `${macHeader}<pre style="margin: 0; padding: 14px 16px; overflow-x: auto; font-family: Consolas, Monaco, 'Courier New', monospace; font-size: 13px; line-height: 1.6; color: #ABB2BF; background-color: ${theme.codeBg}; white-space: pre; word-wrap: normal;"><code style="font-family: Consolas, Monaco, monospace; white-space: pre; color: #ABB2BF; background: none;">${highlighted}</code></pre>`;
    pre.replaceWith(wrapper);
  });

  // 列表
  setStyle("ul, ol", `margin: 8px 0 16px; padding-left: 22px; font-size: ${fs}; line-height: ${lh}; color: #2C2C2A;`);
  root.querySelectorAll("li").forEach((li) => {
    li.setAttribute("style", `margin: 6px 0; font-size: ${fs}; line-height: ${lh}; color: #2C2C2A; text-align: justify;`);
    li.querySelectorAll(":scope > p").forEach((p) => {
      p.setAttribute("style", `margin: 4px 0; font-size: ${fs}; line-height: ${lh}; color: #2C2C2A;`);
    });
  });

  // 分割线
  setStyle("hr", `border: none; border-top: 1px dashed ${hexToRgba(c, 0.35)}; margin: 26px 0;`);

  // 表格（外包横向滚动容器，宽表格在手机端不撑破版面）
  root.querySelectorAll("table").forEach((table) => {
    table.setAttribute(
      "style",
      `width: 100%; border-collapse: collapse; font-size: 13.5px; line-height: 1.5; border: 1px solid #E5E7EB;`
    );
    table.querySelectorAll("th").forEach((th) => {
      const align = th.style.textAlign || "left";
      th.setAttribute("style", `background-color: ${soft}; color: ${c}; font-weight: 700; padding: 8px 10px; border: 1px solid #E5E7EB; text-align: ${align};`);
    });
    table.querySelectorAll("td").forEach((td) => {
      const align = td.style.textAlign || "left";
      td.setAttribute("style", `padding: 8px 10px; border: 1px solid #E5E7EB; color: #374151; text-align: ${align};`);
    });
    const scroller = doc.createElement("section");
    scroller.setAttribute("style", "margin: 18px 0; overflow-x: auto;");
    table.replaceWith(scroller);
    scroller.appendChild(table);
  });

  // 图片与自动图注（Figure Legend）
  let imgCount = 0;
  root.querySelectorAll("img").forEach((img) => {
    imgCount++;
    const origSrc = img.getAttribute("src") || "";
    const altText = (img.getAttribute("alt") || "").trim();

    const figBox = doc.createElement("section");
    figBox.setAttribute("style", "margin: 22px 0; text-align: center;");

    const newImg = doc.createElement("img");
    newImg.setAttribute("src", toLocalImageUrl(origSrc));
    newImg.setAttribute("data-orig-src", origSrc);
    newImg.setAttribute("alt", altText);
    newImg.setAttribute("loading", "lazy");
    newImg.setAttribute(
      "style",
      "max-width: 100%; height: auto; border-radius: 8px; border: 1px solid #EAEAEA; box-shadow: 0 2px 10px rgba(0,0,0,0.05); display: block; margin: 0 auto;"
    );
    figBox.appendChild(newImg);

    if (state.autoCaption && altText) {
      const cap = doc.createElement("p");
      cap.setAttribute("style", "margin: 8px auto 0; font-size: 12.5px; line-height: 1.55; color: #71717A; text-align: center; max-width: 92%;");
      cap.innerHTML = `<span style="color: ${c}; font-weight: 700;">▲</span> ${escapeHtml(altText)}`;
      figBox.appendChild(cap);
    }

    // 若 img 独占一个 <p>，直接替换该 <p>
    const parent = img.parentElement;
    if (parent && parent.tagName === "P" && parent.childNodes.length === 1) {
      parent.replaceWith(figBox);
    } else {
      img.replaceWith(figBox);
    }
  });

  // 文末「相关参考链接」模块
  if (state.footnoteLinks && footnotes.length > 0) {
    const refSec = doc.createElement("section");
    refSec.setAttribute("style", "margin-top: 32px; padding: 14px 16px; background-color: #F9FAFB; border-radius: 8px; border: 1px solid #E5E7EB;");
    const itemsHtml = footnotes
      .map(
        (f, i) =>
          `<p style="margin: 4px 0; font-size: 12px; line-height: 1.5; color: #6B7280; word-break: break-all;"><span style="color: ${c}; font-weight: 700;">[${i + 1}]</span> ${escapeHtml(f.text)}: ${escapeHtml(f.href)}</p>`
      )
      .join("");
    refSec.innerHTML = `<p style="margin: 0 0 8px; font-size: 13px; font-weight: 700; color: ${c};">文中参考链接与开源资源</p>${itemsHtml}`;
    root.appendChild(refSec);
  }

  // 外层包裹标准微信公众号全局容器 section
  const finalHtml = `<section style="font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; font-size: ${fs}; line-height: ${lh}; color: #2C2C2A; padding: 4px 2px; word-wrap: break-word;">${root.innerHTML}</section>`;

  // 统计（排除代码块与图片链接，更贴近实际阅读量）
  const plain = rawMarkdown.replace(/```[\s\S]*?```/g, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  const cnChars = (plain.match(/[\u4e00-\u9fff]/g) || []).length;
  const enWords = (plain.match(/[a-zA-Z0-9_]+/g) || []).length;
  const totalWords = cnChars + enWords;
  const stats = {
    cnChars,
    totalWords,
    imgCount,
    readMins: totalWords ? Math.max(1, Math.ceil(totalWords / 400)) : 0
  };

  return { html: finalHtml, title, stats };
}

// ======================= UI 基础 =======================
const editorEl = $id("mdEditor");
const previewRootEl = $id("wechatContentRoot");

function showToast(msg, duration = 2800, type = "success") {
  const box = $id("toastBox");
  $id("toastText").textContent = msg;
  box.classList.toggle("error", type === "error");
  box.classList.toggle("warn", type === "warn");
  box.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => box.classList.remove("show"), duration);
}

function setRenderStatus(text, level = "ready") {
  const el = $id("renderStatus");
  if (!el) return;
  el.className = `status-ready status-${level}`;
  el.querySelector("span:last-child").textContent = text;
}

function isDirty() {
  return editorEl.value !== state.savedContent;
}

function updateFileLabel() {
  const label = $id("currentFileLabel");
  const hasFile = !!(state.currentFileName || state.pendingNewName);
  const name = state.currentFileName || state.pendingNewName || "新建空白文档";
  label.textContent = hasFile || isDirty() ? `(${name})` : "";
  label.title = state.currentFilePath || "尚未保存到磁盘，Ctrl+S 将保存到工作区";
  label.classList.toggle("dirty", isDirty());
  const delBtn = $id("btnDeleteDoc");
  if (delBtn) delBtn.disabled = !state.currentFilePath;
  document.title = `${isDirty() ? "● " : ""}${name} · WeChat-MD 排版工作台`;
}

let renderScheduled = false;
function updatePreview() {
  if (!md) return;
  const t0 = performance.now();
  const raw = editorEl.value || "";
  const isEmpty = !raw.trim();
  const metaHeaderEl = $id("wxMetaHeader");

  if (isEmpty) {
    if (metaHeaderEl) metaHeaderEl.style.display = "none";
    previewRootEl.innerHTML = `
      <div class="preview-empty-state">
        <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
        <p>在左侧输入、粘贴或从工作区选择 Markdown 文档</p>
        <small>此处将实时生成 100% 微信公众号内联样式排版预览</small>
      </div>`;
    $id("editorStats").textContent = "中文字符：0 | 总词数：0 | 图片：0 张 | 预计阅读：0 分钟";
    updateFileLabel();
    return;
  }

  if (metaHeaderEl) metaHeaderEl.style.display = "";
  const { html, title, stats } = renderWechatArticle(raw);
  previewRootEl.innerHTML = html;

  const titleEl = $id("wxSimTitle");
  if (titleEl && document.activeElement !== titleEl) {
    const fallbackTitle = state.customTitle || (state.currentFileName ? state.currentFileName.replace(/\.[^.]+$/, "") : "");
    titleEl.textContent = title || fallbackTitle;
  }

  $id("editorStats").textContent =
    `中文字符：${stats.cnChars} | 总词数：${stats.totalWords} | 图片：${stats.imgCount} 张 | 预计阅读：${stats.readMins} 分钟`;
  updateFileLabel();
  const cost = performance.now() - t0;
  if (cost > 300) console.info(`[渲染耗时] ${cost.toFixed(0)} ms`);
}

// 合并同一帧内的多次渲染请求
function schedulePreview() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    updatePreview();
  });
}

// ======================= 草稿自动保存 =======================
function saveDraft() {
  if (!isDirty()) {
    localStorage.removeItem(STORAGE_KEYS.draft);
    return;
  }
  saveJSON(STORAGE_KEYS.draft, {
    path: state.currentFilePath,
    name: state.pendingNewName,
    content: editorEl.value,
    ts: Date.now()
  });
}

function clearDraft() {
  localStorage.removeItem(STORAGE_KEYS.draft);
}

// ======================= 本地文件 =======================
function setDocument({ path = "", name = "", baseDir, mtime = null, content = "", pendingName = "", saved = true }) {
  state.currentFilePath = path;
  state.currentFileName = name;
  state.currentFileMtime = mtime;
  state.pendingNewName = pendingName;
  state.customTitle = "";
  state.currentBaseDir = baseDir || state.workspaceDir;
  editorEl.value = content.replace(/\r\n/g, "\n");
  state.savedContent = saved ? editorEl.value : "";
  if (path) {
    state.lastFile = path;
    persistSettings();
  }
  updatePreview();
}

function newBlankDocument({ force = false } = {}) {
  if (!force && !confirmDiscard()) {
    $id("localFileSelect").value = state.currentFilePath;
    return false;
  }
  clearDraft();
  setDocument({ path: "", name: "", content: "", pendingName: "", saved: true });
  $id("localFileSelect").value = "";
  return true;
}

function confirmDiscard() {
  return !isDirty() || confirm("当前文档有未保存的修改，确定要放弃这些修改吗？");
}

async function fetchJSON(url, options) {
  const resp = await fetch(url, options);
  let data;
  try {
    data = await resp.json();
  } catch (_) {
    throw new Error(`服务返回异常（HTTP ${resp.status}）`);
  }
  data.__status = resp.status;
  return data;
}

function renderFileSelectOptions(files) {
  const selectEl = $id("localFileSelect");
  selectEl.innerHTML = "";

  const blankOpt = document.createElement("option");
  blankOpt.value = "";
  blankOpt.textContent = files.length
    ? `✨ 新建空白文档（工作区共 ${files.length} 篇）`
    : "✨ 新建空白文档（当前目录暂无 .md）";
  selectEl.appendChild(blankOpt);

  files.forEach((f) => {
    const opt = document.createElement("option");
    opt.value = f.path;
    opt.textContent = f.name;
    opt.title = `${f.name} (${(f.size / 1024).toFixed(1)} KB)\n路径：${f.path}`;
    selectEl.appendChild(opt);
  });

  selectEl.value = state.currentFilePath || "";
}

// 扫描工作区中的本地 Markdown 文件（默认不强制加载旧文档，保持干净新建状态）
async function loadWorkspaceFiles({ autoOpen = false } = {}) {
  const selectEl = $id("localFileSelect");
  try {
    const data = await fetchJSON("/api/files");
    if (!data.ok) {
      renderFileSelectOptions([]);
      return;
    }
    renderFileSelectOptions(data.files || []);
    if (!autoOpen || !data.files.length) return;

    const preferred = data.files.find((f) => f.path === state.lastFile) || data.files[0];
    if (preferred) {
      selectEl.value = preferred.path;
      await openLocalFile(preferred.path, { force: true });
    }
  } catch (e) {
    console.error("Failed to fetch workspace files:", e);
    selectEl.innerHTML = `<option value="">本地文件接口未连接</option>`;
    showToast("无法连接本地服务，请确认 server.py 正在运行", 4000, "error");
  }
}

async function openLocalFile(path, { force = false } = {}) {
  if (!path) {
    if (newBlankDocument({ force })) showToast("已切换到新建空白文档");
    return;
  }
  if (!force && !confirmDiscard()) {
    $id("localFileSelect").value = state.currentFilePath;
    return;
  }
  try {
    const data = await fetchJSON(`/api/read?path=${encodeURIComponent(path)}`);
    if (!data.ok) return showToast(`读取失败：${data.error}`, 3500, "error");

    setDocument({ path: data.path, name: data.name, baseDir: data.baseDir, mtime: data.mtime, content: data.content });
    $id("localFileSelect").value = data.path;

    // 检测是否存在比磁盘文件更新的未保存草稿
    const draft = loadJSON(STORAGE_KEYS.draft, null);
    if (
      draft && draft.path === data.path && draft.content !== editorEl.value &&
      draft.ts > data.mtime * 1000 &&
      confirm(`检测到「${data.name}」有未保存的草稿（${new Date(draft.ts).toLocaleString()}），是否恢复？`)
    ) {
      editorEl.value = draft.content;
      updatePreview();
      showToast("已恢复未保存草稿，记得 Ctrl+S 保存", 3500, "warn");
    } else {
      showToast(`已加载文档：${data.name}`);
    }
  } catch (e) {
    showToast(`读取异常：${e.message}`, 3500, "error");
  }
}

async function saveCurrentFile({ force = false } = {}) {
  if (!state.currentFilePath && !editorEl.value.trim()) {
    return showToast("当前文档为空，请先输入或粘贴内容后再保存", 2800, "warn");
  }
  let saveName = state.pendingNewName;
  if (!state.currentFilePath && !saveName) {
    const h1 = (editorEl.value.match(/^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)/) || [])[1];
    const defaultName = ((h1 || state.customTitle || "未命名推文").trim().slice(0, 60)) + ".md";
    const inputName = prompt("请输入保存的文件名：", defaultName);
    if (inputName === null) return;
    saveName = inputName.trim() || defaultName;
  }
  try {
    const data = await fetchJSON("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: state.currentFilePath,
        name: saveName,
        content: editorEl.value,
        expectedMtime: state.currentFileMtime,
        force
      })
    });
    if (data.conflict) {
      if (confirm("该文件已在外部（其他编辑器）被修改。\n\n确定：用当前内容覆盖磁盘文件\n取消：放弃保存（可另行复制当前内容）")) {
        return saveCurrentFile({ force: true });
      }
      return showToast("已取消保存", 2500, "warn");
    }
    if (!data.ok) return showToast(`保存失败：${data.error}`, 4000, "error");

    const isNew = !state.currentFilePath;
    state.currentFilePath = data.path;
    state.currentFileName = data.name;
    state.currentFileMtime = data.mtime;
    state.currentBaseDir = data.baseDir;
    state.pendingNewName = "";
    state.savedContent = editorEl.value;
    state.lastFile = data.path;
    persistSettings();
    clearDraft();
    updateFileLabel();
    showToast(`已保存至：${data.path}`);
    if (isNew) loadWorkspaceFiles({ autoOpen: false });
  } catch (e) {
    showToast(`保存出错：${e.message}`, 3500, "error");
  }
}

async function deleteCurrentFile() {
  if (!state.currentFilePath) return;
  const targetName = state.currentFileName || state.currentFilePath;
  if (!confirm(`确定要删除本地文档「${targetName}」吗？\n删除后不可恢复。`)) return;
  try {
    const data = await fetchJSON("/api/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.currentFilePath })
    });
    if (!data.ok) return showToast(`删除失败：${data.error}`, 3500, "error");
    if (state.lastFile === state.currentFilePath) {
      state.lastFile = "";
      persistSettings();
    }
    newBlankDocument({ force: true });
    renderFileSelectOptions(data.files || []);
    showToast(`已删除文档：${targetName}`);
  } catch (e) {
    showToast(`删除出错：${e.message}`, 3500, "error");
  }
}

// ======================= 图片上传（按钮 / 粘贴 / 拖拽共用） =======================
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function uploadAndInsertImages(files) {
  const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
  if (!images.length) return;
  const snippets = [];
  for (const file of images) {
    try {
      const filename = file.name && file.name !== "image.png" ? file.name : `paste_${Date.now()}.png`;
      const data = await fetchJSON("/api/upload-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, dataUrl: await readFileAsDataURL(file) })
      });
      if (!data.ok) throw new Error(data.error);
      snippets.push(`![${filename.replace(/\.[^.]+$/, "")}](${data.path})`);
    } catch (err) {
      showToast(`上传图片失败：${err.message}`, 3500, "error");
    }
  }
  if (snippets.length) {
    insertAtCursor(`\n${snippets.join("\n\n")}\n`);
    showToast(`已插入 ${snippets.length} 张图片`);
  }
}

function insertAtCursor(text, selectInserted = false) {
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  editorEl.focus();
  // 优先使用 execCommand 以保留浏览器原生撤销栈（Ctrl+Z 可撤销）
  const ok = document.execCommand && document.execCommand("insertText", false, text);
  if (!ok) editorEl.setRangeText(text, start, end, "end");
  if (selectInserted) editorEl.setSelectionRange(start, start + text.length);
  onEditorChanged();
}

function importMarkdownFile(file) {
  if (!confirmDiscard()) return;
  const reader = new FileReader();
  reader.onload = () => {
    // 导入的文件与磁盘路径无关联：保存时会写入工作区新文件，不会覆盖之前打开的文档
    setDocument({ content: reader.result, pendingName: file.name, saved: false });
    $id("localFileSelect").value = "";
    showToast(`已导入：${file.name}（Ctrl+S 将另存到工作区）`, 3500);
  };
  reader.readAsText(file, "utf-8");
}

// ======================= 导出与一键复制 =======================
async function fetchImageDataUrl(origSrc) {
  const key = wechatKey(origSrc);
  const hit = base64Cache.get(key);
  if (hit) return hit;
  const j = await fetchJSON(
    `/api/image-base64?path=${encodeURIComponent(origSrc)}&baseDir=${encodeURIComponent(state.currentBaseDir || "")}`
  );
  if (j.ok && j.dataUrl) {
    base64Cache.set(key, j.dataUrl);
    return j.dataUrl;
  }
  throw new Error(j.error || "转换失败");
}

/**
 * 构建可直接粘贴/导出的 HTML：优先使用微信图床 URL，其次（可选）内联压缩后的 Base64。
 * 图片并发处理（4 路），onProgress 回调用于更新按钮文字。
 */
async function buildExportHtml({ inlineImages = state.inlineBase64, onProgress } = {}) {
  const clone = previewRootEl.cloneNode(true);
  const imgs = Array.from(clone.querySelectorAll("img"));
  let done = 0;
  const failed = [];
  const tasks = imgs.map((img) => async () => {
    const origSrc = img.getAttribute("data-orig-src") || img.getAttribute("src") || "";
    img.removeAttribute("loading");
    const wx = getWechatUrl(origSrc);
    if (wx) {
      img.setAttribute("src", wx);
    } else if (inlineImages && isLocalImagePath(origSrc)) {
      try {
        img.setAttribute("src", await fetchImageDataUrl(origSrc));
      } catch (err) {
        failed.push(origSrc);
      }
    }
    img.removeAttribute("data-orig-src");
    onProgress && onProgress(++done, imgs.length);
  });
  const queue = tasks.slice();
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  }));
  if (failed.length) console.warn("以下图片内联失败：", failed);
  return { html: clone.innerHTML, text: clone.innerText || editorEl.value, failed };
}

async function writeClipboard(html, text) {
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" })
        })
      ]);
      return;
    } catch (e) {
      console.warn("ClipboardItem 写入失败，降级为 execCommand：", e);
    }
  }
  // 兼容性降级：隐藏可编辑容器 + execCommand('copy')
  const tempDiv = document.createElement("div");
  tempDiv.contentEditable = "true";
  tempDiv.style.cssText = "position: fixed; left: -99999px; top: 0;";
  tempDiv.innerHTML = html;
  document.body.appendChild(tempDiv);
  const range = document.createRange();
  range.selectNodeContents(tempDiv);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const ok = document.execCommand("copy");
  sel.removeAllRanges();
  document.body.removeChild(tempDiv);
  if (!ok) throw new Error("浏览器拒绝写入剪贴板");
}

async function runCopy(btn, { plainText, successMsg }) {
  const smallEl = btn.querySelector("small");
  const origSmall = smallEl ? smallEl.textContent : "";
  btn.disabled = true;
  try {
    if (smallEl) smallEl.textContent = "正在打包图片...";
    const { html, text, failed } = await buildExportHtml({
      onProgress: (i, n) => smallEl && (smallEl.textContent = `处理图片 ${i}/${n}`)
    });
    await writeClipboard(html, plainText ?? text);
    if (failed.length) showToast(`已复制，但有 ${failed.length} 张图片内联失败（详见控制台）`, 4500, "warn");
    else showToast(successMsg, 4000);
  } catch (e) {
    console.error("Copy error:", e);
    showToast(`复制失败：${e.message}`, 4000, "error");
  } finally {
    btn.disabled = false;
    if (smallEl) smallEl.textContent = origSmall;
  }
}

async function exportHtmlFile() {
  const btn = $id("btnExportHtml");
  btn.disabled = true;
  try {
    // 导出文件需离线可用，因此强制内联本地图片
    const { html } = await buildExportHtml({ inlineImages: true });
    const title = $id("wxSimTitle").textContent || "wechat_article";
    const fullHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="max-width:677px;margin:20px auto;padding:20px;"><h1 style="font-size:22px;line-height:1.4;margin-bottom:20px;">${escapeHtml(title)}</h1>${html}</body></html>`;
    const blob = new Blob([fullHtml], { type: "text/html;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showToast("已导出带完整内联样式与图片的 HTML 文件");
  } catch (e) {
    showToast(`导出失败：${e.message}`, 3500, "error");
  } finally {
    btn.disabled = false;
  }
}

// ======================= 设置面板 ⇄ 状态同步 =======================
function applyThemeColorUI() {
  $id("primaryColorPicker").value = state.primaryColor;
  $id("primaryColorHex").textContent = state.primaryColor.toUpperCase();
}

function syncSettingsUI() {
  document.querySelectorAll(".theme-card[data-theme]").forEach((card) =>
    card.classList.toggle("active", card.dataset.theme === state.themeKey)
  );
  applyThemeColorUI();
  document.querySelectorAll("#fontSizePills .pill-btn").forEach((b) => b.classList.toggle("active", b.dataset.size === state.fontSize));
  document.querySelectorAll("#lineHeightPills .pill-btn").forEach((b) => b.classList.toggle("active", b.dataset.lh === state.lineHeight));
  $id("chkAutoCaption").checked = state.autoCaption;
  $id("chkFootnoteLinks").checked = state.footnoteLinks;
  $id("chkMacCode").checked = state.macCode;
  $id("chkInlineBase64").checked = state.inlineBase64;

  const deviceEl = $id("wechatDevice");
  deviceEl.classList.toggle("mobile-mode", state.device === "mobile");
  deviceEl.classList.toggle("dark-mode", state.mode === "dark");
  $id("btnDeviceDesktop").classList.toggle("active", state.device !== "mobile");
  $id("btnDeviceMobile").classList.toggle("active", state.device === "mobile");
  $id("btnModeLight").classList.toggle("active", state.mode !== "dark");
  $id("btnModeDark").classList.toggle("active", state.mode === "dark");
  $id("appSidebar").classList.toggle("collapsed", !!state.sidebarCollapsed);
  $id("wxAppId").value = state.appId || "";
  if ($id("wxAccountName") && document.activeElement !== $id("wxAccountName")) {
    $id("wxAccountName").textContent = state.accountName || "公众号名称";
  }
  if ($id("wxLocation") && document.activeElement !== $id("wxLocation")) {
    $id("wxLocation").textContent = state.location || "发表于浙江";
  }
  $id("wxOrigTag")?.classList.toggle("inactive", !state.showOrigTag);
  const stageEl = document.querySelector(".main-stage");
  if (stageEl) {
    const ratio = Math.min(78, Math.max(22, Number(state.splitRatio) || 50));
    stageEl.style.setProperty("--split-ratio", `${ratio}%`);
  }
}

// 修改设置：写入状态 → 持久化 → 同步 UI →（可选）重新渲染
function updateSetting(patch, rerender = true) {
  Object.assign(state, patch);
  persistSettings();
  syncSettingsUI();
  if (rerender) schedulePreview();
}

// ======================= 编辑器增强 =======================
let draftTimer = null;
let inputTimer = null;
function onEditorChanged() {
  updateFileLabel();
  clearTimeout(inputTimer);
  // 文档越大防抖越长，兼顾实时性与流畅度
  inputTimer = setTimeout(schedulePreview, editorEl.value.length > 50000 ? 300 : 100);
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 1000);
}

const INSERT_SNIPPETS = {
  bold: (s) => `**${s}**`,
  italic: (s) => `*${s}*`,
  h2: (s) => `\n## ${s}\n`,
  h3: (s) => `\n### ${s}\n`,
  quote: (s) => `\n> ${s.replace(/\n/g, "\n> ")}\n`,
  code: (s) => `\n\`\`\`r\n${s}\n\`\`\`\n`,
  math: (s) => (s === "文本内容" ? "$\\text{HR} = 2.42, p < 0.001$" : `$${s}$`)
};

function applyInsert(type) {
  const fn = INSERT_SNIPPETS[type];
  if (!fn) return;
  const selected = editorEl.value.substring(editorEl.selectionStart, editorEl.selectionEnd) || "文本内容";
  insertAtCursor(fn(selected));
}

function bindEditorEvents() {
  editorEl.addEventListener("input", onEditorChanged);

  editorEl.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Tab / Shift+Tab 缩进（不再跳出编辑器）
    if (e.key === "Tab" && !mod && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en, value } = editorEl;
      if (s === en && !e.shiftKey) return insertAtCursor("  ");
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const block = value.slice(lineStart, en);
      const replaced = e.shiftKey ? block.replace(/^ {1,2}/gm, "") : block.replace(/^/gm, "  ");
      editorEl.setSelectionRange(lineStart, en);
      insertAtCursor(replaced, true);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b") { e.preventDefault(); applyInsert("bold"); }
      else if (k === "i") { e.preventDefault(); applyInsert("italic"); }
    }
  });

  // 粘贴剪贴板中的图片（截图）→ 自动上传并插入
  editorEl.addEventListener("paste", (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      uploadAndInsertImages(files);
    }
  });

  // 拖拽图片插入 / 拖拽 .md 文件导入
  const stage = document.querySelector(".main-stage");
  stage.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      stage.classList.add("drag-over");
    }
  });
  stage.addEventListener("dragleave", (e) => {
    if (!stage.contains(e.relatedTarget)) stage.classList.remove("drag-over");
  });
  stage.addEventListener("drop", (e) => {
    stage.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    e.preventDefault();
    const mdFile = files.find((f) => /\.(md|markdown|txt)$/i.test(f.name));
    if (mdFile) return importMarkdownFile(mdFile);
    uploadAndInsertImages(files);
  });

  // 左右两侧同步滚动（以鼠标所在面板为主动方）
  const viewportEl = $id("previewViewport");
  let activeScroll = "editor";
  editorEl.addEventListener("mouseenter", () => (activeScroll = "editor"));
  editorEl.addEventListener("focus", () => (activeScroll = "editor"));
  viewportEl.addEventListener("mouseenter", () => (activeScroll = "preview"));
  const syncScroll = (from, to) => {
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  };
  editorEl.addEventListener("scroll", () => activeScroll === "editor" && syncScroll(editorEl, viewportEl), { passive: true });
  viewportEl.addEventListener("scroll", () => activeScroll === "preview" && syncScroll(viewportEl, editorEl), { passive: true });
}

// ======================= 左右分栏拖拽调节 =======================
function bindPaneResizer() {
  const resizer = $id("paneResizer");
  const stage = document.querySelector(".main-stage");
  if (!resizer || !stage) return;

  let dragging = false;

  resizer.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    document.body.classList.add("resizing-panes");
    e.preventDefault();
  });

  resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    const pad = 16; // 与 .main-stage 左右 padding 对齐
    const innerWidth = Math.max(1, rect.width - pad * 2);
    const offsetX = e.clientX - (rect.left + pad);
    const pct = Math.min(78, Math.max(22, Math.round((offsetX / innerWidth) * 1000) / 10));
    state.splitRatio = pct;
    stage.style.setProperty("--split-ratio", `${pct}%`);
  });

  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      resizer.releasePointerCapture(e.pointerId);
    } catch (_) {}
    resizer.classList.remove("dragging");
    document.body.classList.remove("resizing-panes");
    persistSettings();
  };

  resizer.addEventListener("pointerup", stopDrag);
  resizer.addEventListener("pointercancel", stopDrag);

  // 双击恢复 50:50 等宽
  resizer.addEventListener("dblclick", () => {
    updateSetting({ splitRatio: 50 }, false);
    showToast("已恢复左右等宽 (50% : 50%)");
  });
}

// ======================= 全局事件绑定 =======================
function bindEvents() {
  bindEditorEvents();
  bindPaneResizer();

  // 文档管理
  $id("localFileSelect").addEventListener("change", (e) => openLocalFile(e.target.value));
  $id("btnDeleteDoc")?.addEventListener("click", deleteCurrentFile);
  $id("btnNewDoc")?.addEventListener("click", () => {
    if (newBlankDocument()) showToast("已新建空白文档");
  });
  $id("btnRefreshFiles")?.addEventListener("click", async () => {
    await loadWorkspaceFiles({ autoOpen: false });
    showToast("文档列表已刷新");
  });

  // 预览区顶部公众号信息栏（标题、原创标识、公众号名、地区）直接点击编辑
  $id("wxOrigTag")?.addEventListener("click", () => updateSetting({ showOrigTag: !state.showOrigTag }, false));
  $id("wxAccountName")?.addEventListener("blur", (e) => {
    const val = e.currentTarget.textContent.trim() || "公众号名称";
    e.currentTarget.textContent = val;
    updateSetting({ accountName: val }, false);
  });
  $id("wxLocation")?.addEventListener("blur", (e) => {
    const val = e.currentTarget.textContent.trim() || "发表于浙江";
    e.currentTarget.textContent = val;
    updateSetting({ location: val }, false);
  });
  $id("wxSimTitle")?.addEventListener("input", (e) => {
    const newTitle = e.currentTarget.textContent.replace(/\r?\n/g, " ").trim();
    state.customTitle = newTitle;
    if (/^\s*#[ \t]+(.+?)[ \t#]*(?:\n|$)/.test(editorEl.value)) {
      editorEl.value = editorEl.value.replace(/^\s*#[ \t]+.+?(?=\n|$)/, `# ${newTitle}`);
      updateFileLabel();
    }
  });
  [$id("wxSimTitle"), $id("wxAccountName"), $id("wxLocation")].forEach((el) =>
    el?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.blur();
      }
    })
  );
  $id("btnUploadMd").addEventListener("click", () => $id("inputUploadMd").click());
  $id("inputUploadMd").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) importMarkdownFile(file);
    e.target.value = ""; // 允许重复导入同一文件
  });
  $id("btnSaveLocal").addEventListener("click", () => saveCurrentFile());
  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
    if (e.key === "Escape") $id("wechatApiModal").classList.remove("open");
  });
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      saveDraft();
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // 侧边栏收起与展开
  $id("btnCollapseSidebar").addEventListener("click", () => updateSetting({ sidebarCollapsed: true }, false));
  $id("btnExpandSidebar").addEventListener("click", () => updateSetting({ sidebarCollapsed: false }, false));

  // 主题卡片
  document.querySelectorAll(".theme-card[data-theme]").forEach((card) => {
    card.addEventListener("click", () => {
      const theme = THEMES[card.dataset.theme];
      if (!theme) return;
      updateSetting({ themeKey: card.dataset.theme, primaryColor: theme.primary });
      showToast(`已切换主题：${theme.name}`);
    });
  });

  // 主色调（input 实时预览不持久化，change 时再持久化）
  const picker = $id("primaryColorPicker");
  picker.addEventListener("input", (e) => {
    state.primaryColor = e.target.value;
    $id("primaryColorHex").textContent = state.primaryColor.toUpperCase();
    schedulePreview();
  });
  picker.addEventListener("change", (e) => updateSetting({ primaryColor: e.target.value }));

  // 字号 / 行距胶囊
  document.querySelectorAll("#fontSizePills .pill-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateSetting({ fontSize: btn.dataset.size }))
  );
  document.querySelectorAll("#lineHeightPills .pill-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateSetting({ lineHeight: btn.dataset.lh }))
  );

  // 增强开关
  const toggles = { chkAutoCaption: "autoCaption", chkFootnoteLinks: "footnoteLinks", chkMacCode: "macCode", chkInlineBase64: "inlineBase64" };
  Object.entries(toggles).forEach(([id, key]) =>
    $id(id).addEventListener("change", (e) => updateSetting({ [key]: e.target.checked }, key !== "inlineBase64"))
  );

  // 宽屏 / 手机、浅色 / 深色
  $id("btnDeviceDesktop").addEventListener("click", () => updateSetting({ device: "desktop" }, false));
  $id("btnDeviceMobile").addEventListener("click", () => updateSetting({ device: "mobile" }, false));
  $id("btnModeLight").addEventListener("click", () => updateSetting({ mode: "light" }, false));
  $id("btnModeDark").addEventListener("click", () => updateSetting({ mode: "dark" }, false));

  // 快捷插入工具栏
  document.querySelectorAll(".tool-icon-btn[data-insert]").forEach((btn) =>
    btn.addEventListener("click", () => applyInsert(btn.dataset.insert))
  );

  // 插入本地图片
  $id("btnInsertImg").addEventListener("click", () => $id("inputInsertImg").click());
  $id("inputInsertImg").addEventListener("change", async (e) => {
    await uploadAndInsertImages(e.target.files);
    e.target.value = "";
  });

  // 导出与复制
  $id("btnExportHtml").addEventListener("click", exportHtmlFile);
  $id("btnCopyWechat").addEventListener("click", (e) =>
    runCopy(e.currentTarget, { successMsg: "已复制到剪贴板，请前往微信公众号后台直接按 Ctrl+V 粘贴" })
  );
  // CSDN：同时写入富文本 HTML 与原始 Markdown（适配 CSDN 两种编辑器）
  $id("btnCopyCsdn").addEventListener("click", (e) =>
    runCopy(e.currentTarget, {
      plainText: editorEl.value || "",
      successMsg: "已复制 CSDN 专属格式，可直接在 CSDN 富文本或 Markdown 编辑器 Ctrl+V 粘贴"
    })
  );

  bindWechatModal();
}

function bindWechatModal() {
  const modal = $id("wechatApiModal");
  $id("btnWechatApiModal").addEventListener("click", () => modal.classList.add("open"));
  $id("btnCloseModal").addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", (e) => e.target === modal && modal.classList.remove("open"));

  $id("btnUploadToWechatServer").addEventListener("click", async () => {
    const appId = $id("wxAppId").value.trim();
    const appSecret = $id("wxAppSecret").value.trim();
    if (!appId || !appSecret) return showToast("请先填写 AppID 与 AppSecret", 3000, "warn");

    // 只上传尚未上传过的本地图片
    const imgs = [...new Set(
      Array.from(previewRootEl.querySelectorAll("img"))
        .map((img) => img.getAttribute("data-orig-src"))
        .filter((src) => isLocalImagePath(src) && !getWechatUrl(src))
    )];
    if (!imgs.length) return showToast("当前文章中没有需要上传的本地图片（已上传的会自动复用）");

    updateSetting({ appId }, false); // 仅记住 AppID，AppSecret 不落盘
    const btn = $id("btnUploadToWechatServer");
    const origBtnHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = `正在上传 ${imgs.length} 张图片至微信服务器...`;
    try {
      const data = await fetchJSON("/api/wechat/upload-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, appSecret, images: imgs, baseDir: state.currentBaseDir })
      });
      if (!data.ok) return showToast(`微信上传失败：${data.error}`, 5000, "error");

      Object.entries(data.urlMap || {}).forEach(([src, url]) => (state.uploadedWechatUrls[wechatKey(src)] = url));
      saveJSON(STORAGE_KEYS.wechatUrls, state.uploadedWechatUrls);
      updatePreview();
      const okCount = Object.keys(data.urlMap || {}).length;
      const failed = data.failed || [];
      if (failed.length) {
        console.warn("微信上传失败明细：", failed);
        showToast(`成功 ${okCount} 张，失败 ${failed.length} 张：${failed[0].error}`, 6000, "warn");
      } else {
        modal.classList.remove("open");
        showToast(`成功上传 ${okCount} 张图片至微信官方素材库`);
      }
    } catch (e) {
      showToast(`请求失败：${e.message}`, 4000, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = origBtnHtml;
    }
  });
}

// ======================= 启动初始化 =======================
// MathJax 就绪回调（在 index.html 的 MathJax 配置 pageReady 中调用）
window.__onMathJaxReady = () => {
  mathCache.clear();
  setRenderStatus("MathJax SVG 公式引擎与本地图片映射已就绪", "ready");
  updatePreview();
};

window.addEventListener("DOMContentLoaded", async () => {
  if (!md) {
    setRenderStatus("Markdown 引擎加载失败，请检查网络（CDN）后刷新", "error");
    showToast("markdown-it 加载失败，请检查网络连接后刷新页面", 8000, "error");
    return;
  }
  $id("wxSimDate").textContent = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
  syncSettingsUI();
  bindEvents();
  if (!mathJaxReady()) setRenderStatus("MathJax 公式引擎加载中...", "loading");

  try {
    const cfg = await fetchJSON("/api/config");
    if (cfg.ok) state.workspaceDir = cfg.workspaceDir;
  } catch (_) {}
  state.currentBaseDir = state.workspaceDir;

  // 默认进入干净的新建空白文档状态，同时加载工作区文档下拉列表供随时选用
  await loadWorkspaceFiles({ autoOpen: false });
  newBlankDocument({ force: true });

  // 若存在未保存的新文档草稿，询问是否恢复
  const draft = loadJSON(STORAGE_KEYS.draft, null);
  if (draft && !draft.path && draft.content && confirm("检测到上次未保存的新文档草稿，是否恢复？")) {
    setDocument({ content: draft.content, pendingName: draft.name || "", saved: false });
  }

  // MathJax 兜底：若 15 秒后仍未就绪则提示
  setTimeout(() => {
    if (!mathJaxReady()) setRenderStatus("MathJax 加载失败，公式将以源码显示", "error");
  }, 15000);
});
