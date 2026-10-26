/* ============================================================
   LumeMarkdown — Markdown 语法高亮 + 预览渲染
   两个能力：
     render(src)  → 高亮 HTML（供编辑器双图层上色，复用 tok-* 类）
     toHTML(src)  → 预览 HTML（自己写的极简 GFM 子集，无第三方库）
   支持：ATX 标题、粗体/斜体/删除线、行内代码、围栏代码块、
   引用、有序/无序列表（含嵌套）、任务清单、表格、分隔线、
   链接、图片、自动链接、硬换行。
   ============================================================ */

const LumeMarkdown = (function () {
  /* ---------------- 通用 ---------------- */
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* raw=true 时内容已经是 HTML（inline() 的产物），不再转义 */
  const span = (cls, text, raw) =>
    text ? '<span class="' + cls + '">' + (raw ? text : esc(text)) + '</span>' : '';

  /* ============================================================
     一、高亮（逐行扫描，保证与 textarea 逐字符对齐）
     ============================================================ */
  function inline(src) {
    /* 行内元素先粗后细：代码 > 图片 > 链接 > 强调 */
    let out = '';
    let i = 0;
    const n = src.length;

    while (i < n) {
      const c = src[i];

      /* 行内代码 `code` */
      if (c === '`') {
        let j = src.indexOf('`', i + 1);
        if (j > i) {
          out += span('tok-md-code', src.slice(i, j + 1));
          i = j + 1;
          continue;
        }
      }

      /* 图片 ![alt](url) */
      if (c === '!' && src[i + 1] === '[') {
        const m = /^!\[[^\]]*\]\([^)]*\)/.exec(src.slice(i));
        if (m) {
          out += span('tok-md-image', m[0]);
          i += m[0].length;
          continue;
        }
      }

      /* 链接 [text](url) */
      if (c === '[') {
        const m = /^\[[^\]]*\]\([^)]*\)/.exec(src.slice(i));
        if (m) {
          const whole = m[0];
          const close = whole.lastIndexOf('](');
          out +=
            span('tok-md-link-b', '[') +
            span('tok-md-link', whole.slice(1, close)) +
            span('tok-md-link-b', '](' + whole.slice(close + 2));
          i += whole.length;
          continue;
        }
      }

      /* 自动链接 <https://...> */
      if (c === '<') {
        const m = /^<https?:\/\/[^>\s]+>/.exec(src.slice(i));
        if (m) {
          out += span('tok-md-link', m[0]);
          i += m[0].length;
          continue;
        }
      }

      /* 粗斜体 / 粗体 / 斜体 / 删除线 */
      const strong3 = /^(\*\*\*|___)(?=\S)[\s\S]*?\1/.exec(src.slice(i));
      if (strong3) {
        out += span('tok-md-strong tok-md-em', strong3[0]);
        i += strong3[0].length;
        continue;
      }
      const strong = /^(\*\*|__)(?=\S)[\s\S]*?\1/.exec(src.slice(i));
      if (strong) {
        out += span('tok-md-strong', strong[0]);
        i += strong[0].length;
        continue;
      }
      const em = /^(\*|_)(?=\S)[^*_\s][^*_]*?\1/.exec(src.slice(i));
      if (em) {
        out += span('tok-md-em', em[0]);
        i += em[0].length;
        continue;
      }
      if (c === '~' && src[i + 1] === '~') {
        const m = /^~~(?=\S)[\s\S]*?~~/.exec(src.slice(i));
        if (m) {
          out += span('tok-md-strike', m[0]);
          i += m[0].length;
          continue;
        }
      }

      /* 普通字符攒一段再一次输出，减少 span 数量 */
      let j = i + 1;
      while (j < n && !'`![]<*_~'.includes(src[j])) j++;
      out += esc(src.slice(i, j));
      i = j;
    }
    return out;
  }

  function renderLine(line) {
    const raw = line;

    /* 空行 */
    if (!raw.trim()) return '<span class="tok-md-blank"> </span>';

    /* 围栏代码块标记 */
    if (/^\s*(```|~~~)/.test(raw)) {
      return '<span class="tok-md-fence">' + esc(raw) + '</span>';
    }

    /* 标题 */
    const h = /^(\s*)(#{1,6})(\s+)([\s\S]*)$/.exec(raw);
    if (h) {
      return (
        esc(h[1]) +
        span('tok-md-marker', h[2]) +
        esc(h[3]) +
        span('tok-md-h', inline(h[4]), true)
      );
    }

    /* 引用 */
    const q = /^(\s*>+\s?)([\s\S]*)$/.exec(raw);
    if (q) {
      return span('tok-md-quote-marker', q[1]) + span('tok-md-quote', inline(q[2]), true);
    }

    /* 分隔线 */
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      return span('tok-md-hr', raw);
    }

    /* 列表项：缩进 + 标记 + 内容（任务清单另算） */
    const li = /^(\s*)([-*+]|\d+[.)])(\s+)([\s\S]*)$/.exec(raw);
    if (li) {
      const rest = li[4];
      const task = /^(\[[ xX]\])(\s*)([\s\S]*)$/.exec(rest);
      if (task) {
        return (
          esc(li[1]) +
          span('tok-md-list', li[2]) +
          esc(li[3]) +
          span('tok-md-task', task[1]) +
          esc(task[2]) +
          inline(task[3])
        );
      }
      return esc(li[1]) + span('tok-md-list', li[2]) + esc(li[3]) + inline(rest);
    }

    /* 表格行 */
    if (/^\s*\|.*\|\s*$/.test(raw) || /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(raw)) {
      const isSep = /^[\s|:-]+$/.test(raw);
      return span(isSep ? 'tok-md-tablesep' : 'tok-md-table', raw);
    }

    return inline(raw);
  }

  function render(src) {
    const lines = String(src).split('\n');
    return lines.map(renderLine).join('\n');
  }

  /* ============================================================
     二、预览渲染（极简 GFM）
     ============================================================ */
  function inlineHTML(src) {
    let s = esc(src);

    /* 行内代码先抠出来，避免里面的 * 被当成强调（用不带 & 的占位符，免得被标签替换吃掉） */
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return '\u0001' + (codes.length - 1) + '\u0001';
    });

    /* 图片 / 链接（顺序不能反）：只放行安全协议 */
    const safeUrl = (u) => /^(https?:|mailto:|\/|\.\/|\.\.\/|#)/i.test(u);
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, alt, url) =>
      safeUrl(url) ? '<img src="' + url + '" alt="' + alt + '" loading="lazy">' : alt
    );
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (m, text, url) =>
      safeUrl(url) ? '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : text
    );
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');

    /* 强调 */
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\s][^_]*)_(?=[^_\w]|$)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    /* 还原行内代码 */
    s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + codes[Number(i)] + '</code>');
    return s;
  }

  function toHTML(src) {
    const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;

    /* 列表 / 引用用栈管理嵌套 */
    let listStack = [];   // [{ ordered, indent }]
    let quote = false;
    let taskList = false;

    function closeList(toIndent) {
      while (listStack.length && listStack[listStack.length - 1].indent >= (toIndent === undefined ? -1 : toIndent)) {
        out.push(listStack.pop().ordered ? '</ol>' : '</ul>');
        taskList = false;
      }
    }
    function closeQuote() {
      if (quote) {
        out.push('</blockquote>');
        quote = false;
      }
    }
    function closeAll() {
      closeList(-1);
      closeQuote();
    }

    while (i < lines.length) {
      const line = lines[i];

      /* 围栏代码块 */
      const fence = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/.exec(line);
      if (fence) {
        closeAll();
        const marker = fence[1];
        const lang = fence[2] || '';
        const buf = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + marker + '\\s*$').test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push(
          '<pre class="md-code"' + (lang ? ' data-lang="' + esc(lang) + '"' : '') + '><code>' +
          esc(buf.join('\n')) +
          '</code></pre>'
        );
        continue;
      }

      /* 空行 */
      if (!line.trim()) {
        closeAll();
        i++;
        continue;
      }

      /* 标题 */
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) {
        closeAll();
        const lv = h[1].length;
        out.push('<h' + lv + '>' + inlineHTML(h[2].replace(/\s+#+\s*$/, '')) + '</h' + lv + '>');
        i++;
        continue;
      }

      /* 分隔线 */
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        closeAll();
        out.push('<hr>');
        i++;
        continue;
      }

      /* 表格：本行有 | 且下一行是分隔行 */
      if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
        closeAll();
        const cell = (row) =>
          row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
        const head = cell(line);
        const aligns = cell(lines[i + 1]).map((c) => {
          const l = c.startsWith(':');
          const r = c.endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          rows.push(cell(lines[i]));
          i++;
        }
        const al = (k) => (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '');
        out.push('<table class="md-table"><thead><tr>');
        head.forEach((c, k) => out.push('<th' + al(k) + '>' + inlineHTML(c) + '</th>'));
        out.push('</tr></thead><tbody>');
        rows.forEach((r) => {
          out.push('<tr>');
          head.forEach((_, k) => out.push('<td' + al(k) + '>' + inlineHTML(r[k] || '') + '</td>'));
          out.push('</tr>');
        });
        out.push('</tbody></table>');
        continue;
      }

      /* 引用 */
      const q = /^\s*>\s?(.*)$/.exec(line);
      if (q) {
        closeList(-1);
        if (!quote) {
          out.push('<blockquote>');
          quote = true;
        }
        out.push('<p>' + inlineHTML(q[1]) + '</p>');
        i++;
        continue;
      }
      closeQuote();

      /* 列表：把连续列表行一次收完，按缩进建成树再输出，避免顶层 <ul> 满天飞 */
      const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (li) {
        closeList(-1);
        closeQuote();

        const items = [];
        while (i < lines.length) {
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
          if (!m) break;
          items.push({
            indent: m[1].replace(/\t/g, '    ').length,
            ordered: /\d/.test(m[2]),
            text: m[3],
            children: []
          });
          i++;
        }

        /* 用栈把扁平列表按缩进折叠成树 */
        const root = { indent: -1, ordered: items[0].ordered, children: [] };
        const stack = [root];
        items.forEach((it) => {
          while (stack.length > 1 && it.indent <= stack[stack.length - 1].indent) stack.pop();
          const parentNode = stack[stack.length - 1];
          parentNode.children.push(it);
          stack.push(it);
        });

        const emit = (node, isRoot) => {
          const tag = node.ordered ? 'ol' : 'ul';
          out.push('<' + tag + '>');
          node.children.forEach((c) => {
            const task = /^\[([ xX])\]\s+(.*)$/.exec(c.text);
            if (task) {
              out.push(
                '<li class="md-task"><input type="checkbox" disabled' +
                (task[1].toLowerCase() === 'x' ? ' checked' : '') +
                '><span>' + inlineHTML(task[2]) + '</span>'
              );
            } else {
              out.push('<li>' + inlineHTML(c.text));
            }
            if (c.children.length) emit(c, false);
            out.push('</li>');
          });
          out.push('</' + tag + '>');
        };
        emit(root, true);
        continue;
      }

      /* 普通段落：连续非空行合并 */
      closeList(-1);
      const para = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~)/.test(lines[i]) &&
        !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      out.push('<p>' + para.map(inlineHTML).join('<br>') + '</p>');
    }

    closeAll();
    return out.join('\n');
  }

  function isMarkdown(path) {
    return /\.(md|markdown|mdown|mkd)$/i.test(path || '');
  }

  return { render, toHTML, isMarkdown };
})();

if (typeof window !== 'undefined') window.LumeMarkdown = LumeMarkdown;
