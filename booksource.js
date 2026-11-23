(function () {
  "use strict";

  // ============================================================
  // Legado 旧式书源规则解析器（子集实现）
  // 规则长相："class.result-item.0@tag.a.0@text"
  //   @  分隔查询段，逐级下钻
  //   |  回退分支（第一个非空胜出）
  //   &  合并分支（结果拼数组）
  //   #  正则替换（必须正好两个 #）
  // ============================================================

  // 取值器关键字：出现在最后一段时表示「取值」而不是「查找元素」。
  const BS_EXTRACTORS = ["text", "textnodes", "href", "src", "html"];

  // 把一段（如 "class.result-item.0"）拆成 { type, name, pos }。
  // 名称可能自带点号，所以从右往左找最后一个纯整数当位置。
  function bsParseStop(stop) {
    try {
      const raw = String(stop ?? "").trim();

      if (!raw) {
        return null;
      }

      const parts = raw.split(".");

      if (parts.length < 2) {
        // 没有点号：不是合法的查询段（"text" 这类取值器由调用方单独处理）。
        return null;
      }

      const type = parts[0].trim();
      let pos = null;

      // 只有末尾那块是纯整数（允许负号）才当位置，否则整段都是名称。
      const last = parts[parts.length - 1].trim();

      if (parts.length >= 3 && /^-?\d+$/.test(last)) {
        pos = Number(last);
        parts.pop();
      }

      const name = parts.slice(1).join(".").trim();

      if (!name) {
        return null;
      }

      return { type, name, pos };
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  // 在一批节点上应用一段，返回单个元素、元素数组或 null。
  // 书源里每一段就是一次「按 class/id/tag 定位」。
  // 输入可以是单个节点，也可以是上一段返回的数组（逐项应用再合并）。
  function bsApplyStop(node, stop) {
    try {
      const parsed = stop && typeof stop === "object" ? stop : bsParseStop(stop);

      if (!parsed || !node) {
        return null;
      }

      // 数组输入：对每个元素应用同一段，把结果摊平。
      // 例如 "class.item" 拿到 2 个 div 后，再套 "tag.a.0" 要逐项查。
      if (Array.isArray(node)) {
        const collected = [];

        for (const item of node) {
          const result = bsApplyStop(item, parsed);

          if (Array.isArray(result)) {
            collected.push(...result);
          } else if (result !== null) {
            collected.push(result);
          }
        }

        return collected.length > 0 ? collected : null;
      }

      const { type, name, pos } = parsed;
      const lowerType = String(type).toLowerCase();
      let selector;

      if (lowerType === "class") {
        selector = "." + name;
      } else if (lowerType === "id") {
        selector = "#" + name;
      } else if (lowerType === "tag") {
        selector = name;
      } else {
        // 不认识的类型直接放弃，别猜。
        return null;
      }

      // 用 querySelectorAll 而不是 querySelector：没位置时要返回全部。
      const list = Array.from(node.querySelectorAll(selector));

      if (list.length === 0) {
        return null;
      }

      if (pos === null) {
        return list;
      }

      // 负数从末尾数：-1 是最后一个。
      const index = pos < 0 ? list.length + pos : pos;

      return list[index] ?? null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  // 取值器：把定位到的元素转成书源要的字符串。
  // text / textNodes / href / src / html 是书源里最常用的几种。
  // 输入数组时逐项取值，返回数组。
  function bsExtract(node, kind) {
    try {
      if (!node) {
        return null;
      }

      if (Array.isArray(node)) {
        const values = node.map((item) => bsExtract(item, kind));

        return values.length > 0 ? values : null;
      }

      const lowerKind = String(kind ?? "").trim().toLowerCase();

      if (lowerKind === "text") {
        // 连续空白压成一个空格：书源里的 text 通常用于书名/作者。
        return String(node.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }

      if (lowerKind === "textnodes") {
        // 只取直接子文本节点：正文段落用这个，避免把子元素文字混进来。
        const lines = Array.from(node.childNodes)
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => String(child.textContent ?? "").trim())
          .filter((line) => line.length > 0);

        return lines.join("\n").trim();
      }

      if (lowerKind === "href" || lowerKind === "src") {
        return node.getAttribute(lowerKind);
      }

      if (lowerKind === "html") {
        return node.innerHTML;
      }

      return null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  // 结果是否算「空」：null / undefined / 空串 / 空数组。
  // | 回退分支靠它判断要不要试下一条。
  function bsIsEmpty(value) {
    if (value === null || value === undefined) {
      return true;
    }

    if (typeof value === "string") {
      return value.trim() === "";
    }

    if (Array.isArray(value)) {
      return value.length === 0;
    }

    return false;
  }

  // 把规则里的 #正则# 切出来。只有正好两个 # 才算正则，
  // 否则 # 当普通字符，避免把书名里的 # 误当分隔符。
  function bsSplitRegex(rule) {
    const text = String(rule ?? "");
    const parts = text.split("#");

    if (parts.length !== 3) {
      return { body: text, pattern: null, replacement: null };
    }

    return {
      body: parts[0],
      pattern: parts[1],
      replacement: parts[2],
    };
  }

  // 求值一条分支（不含 | 和 &）：按 @ 切段，从 root 逐级下钻。
  // 中间任何一段失败，整条分支返回 null。
  function bsEvalBranch(branch, rootNode) {
    const stops = String(branch ?? "")
      .split("@")
      .map((stop) => stop.trim())
      .filter((stop) => stop.length > 0);

    if (stops.length === 0) {
      return null;
    }

    let current = rootNode;

    for (let index = 0; index < stops.length; index += 1) {
      const raw = stops[index];
      const isLast = index === stops.length - 1;

      // 取值器是「裸词」（没有点号），必须在 parseStop 之前识别，
      // 否则会被当成非法查询段而整条分支失败。
      if (isLast && BS_EXTRACTORS.includes(raw.toLowerCase())) {
        return bsExtract(current, raw);
      }

      const stop = bsParseStop(raw);

      if (!stop) {
        return null;
      }

      const next = bsApplyStop(current, stop);

      if (next === null) {
        return null;
      }

      current = next;

      // 最后一段不是取值器：把定位到的元素/数组原样返回。
      if (isLast) {
        return current;
      }
    }

    return current;
  }

  // 主函数：求值一条书源规则。
  // 依次处理 #正则# → | / & 分支 → @ 分段下钻 → 取值器。
  function bsEvalRule(rule, rootNode) {
    try {
      if (!rule || !rootNode) {
        return null;
      }

      const { body, pattern, replacement } = bsSplitRegex(rule);
      let result;

      // % 这个子集不支持，按 | 处理并提示。
      if (body.includes("%")) {
        console.warn("bsEvalRule: 暂不支持 % 运算，按 | 处理：", rule);
      }

      const normalized = body.replace(/%/g, "|");

      if (normalized.includes("&")) {
        // & 合并：所有分支都求值，结果拼成数组。
        const branches = normalized
          .split("&")
          .map((branch) => branch.trim())
          .filter(Boolean);

        const collected = [];

        for (const branch of branches) {
          const value = bsEvalBranch(branch, rootNode);

          if (bsIsEmpty(value)) {
            continue;
          }

          if (Array.isArray(value)) {
            collected.push(...value);
          } else {
            collected.push(value);
          }
        }

        result = collected.length > 0 ? collected : null;
      } else if (normalized.includes("|")) {
        // | 回退：依次求值，第一个非空结果胜出。
        const branches = normalized
          .split("|")
          .map((branch) => branch.trim())
          .filter(Boolean);

        result = null;

        for (const branch of branches) {
          const value = bsEvalBranch(branch, rootNode);

          if (!bsIsEmpty(value)) {
            result = value;
            break;
          }
        }
      } else {
        result = bsEvalBranch(normalized, rootNode);
      }

      // 正则替换只作用于字符串结果；数组/元素原样返回。
      if (pattern !== null && typeof result === "string") {
        try {
          result = result.replace(new RegExp(pattern, "g"), replacement);
        } catch (error) {
          console.error("bsEvalRule: 正则无效，跳过替换", error);
        }
      }

      return result;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  // 列表规则：先取一批元素，再对每个元素套子规则。
  // 这是书源里「搜索列表 / 目录列表」的标准结构。
  function bsEvalList(listRule, itemRule, rootNode) {
    try {
      const nodes = bsEvalRule(listRule, rootNode);

      if (!Array.isArray(nodes) || nodes.length === 0) {
        return [];
      }

      return nodes.map((node) => bsEvalRule(itemRule, node));
    } catch (error) {
      console.error(error);
      return [];
    }
  }

  // 把 HTML 字符串转成可查询的节点。
  // 返回 doc.body：书源规则通常从列表容器开始，body 正好当根。
  function bsParseHtml(htmlText) {
    try {
      const doc = new DOMParser().parseFromString(
        String(htmlText ?? ""),
        "text/html"
      );

      return doc.body;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  window.bsParseStop = bsParseStop;
  window.bsApplyStop = bsApplyStop;
  window.bsExtract = bsExtract;
  window.bsEvalRule = bsEvalRule;
  window.bsEvalList = bsEvalList;
  window.bsParseHtml = bsParseHtml;
})();
