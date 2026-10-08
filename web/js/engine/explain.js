/* 证据链与解释生成 —— engine.py:441-453（章节归一）+ 194-277（证据链/最好出处）
 * + 1352-1440（分项展示/解释拼装）的移植。
 *
 * 这是**用户直接读到的文字**：逐字释义、原文可核、证据链、分项参考、边界说明。
 * 因此对拍要比**整段字符串**（含换行与标点），而不是"意思差不多"。
 *
 * 两个必须照抄的判定：
 *   · best_citation 优先采用字库自带的 citation（人工核校层），再去比语义推断——
 *     否则"崟"会被绑到"泠然"那句上；
 *   · 逐字解释与证据链**共用同一次判定**，保证同一候选里两处说法一致。
 *
 * 用法：const { buildExplanation, evidenceChain, bestCitation } = require('./web/js/engine/explain.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMExplain = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function dep(name) {
    if (typeof module === 'object' && module.exports) { return require('./' + name + '.js'); }
    return root[{ pyround: 'GDMPyRound', select: 'GDMSelect' }[name]];
  }
  var R = dep('pyround');
  var SEL = dep('select');

  /* 把'《论语·子张》'这类章节字段归一为'子张'，避免书名重复显示。 */
  function normChapter(chapter, classicName) {
    if (!chapter) { return ''; }
    var s = String(chapter).trim().replace(/^《+|》+$/g, '');
    var dot = s.indexOf('·');
    if (dot >= 0) {
      var head = s.slice(0, dot);
      var tail = s.slice(dot + 1);
      var cn = classicName ? String(classicName).replace(/^《+|》+$/g, '') : null;
      if (cn && head.replace(/^《+|》+$/g, '') === cn) { return tail; }
      return s;
    }
    var cn2 = classicName ? String(classicName).replace(/^《+|》+$/g, '') : null;
    if (cn2 && s === cn2) { return ''; }
    return s;
  }

  /* 该字的证据链：语义 → 原文 → 古籍（同名语义只保留一条）。 */
  function evidenceChain(kb, charId) {
    var out = [], seen = {};
    var list = kb.charSemantics[charId] || [];
    for (var i = 0; i < list.length; i++) {
      var sc = list[i];
      if (seen[sc.semantic_id]) { continue; }
      seen[sc.semantic_id] = true;
      var sem = kb.semantic[sc.semantic_id];
      if (!sem) { continue; }
      var txt = sem.text_id ? kb.texts[sem.text_id] : null;
      var cls = (txt && txt.classic_id) ? kb.classics[txt.classic_id] : null;
      out.push({
        semantic_id: sem.semantic_id,
        semantic_name: sem.name,
        contribution: sc.contribution,
        text_id: sem.text_id,
        content: txt ? txt.content : null,
        chapter: txt ? txt.chapter : null,
        classic: cls ? cls.name : null,
        verified: !!sem.verified
      });
    }
    return out;
  }

  /* 该字最可信的出处。返回 {cites, conflicts}。 */
  function bestCitation(kb, charId) {
    var chain = evidenceChain(kb, charId).filter(function (c) {
      return c.verified && c.content;
    });
    var h = kb.hanzi[charId];
    var own = String(h.persona_semantic || '') + String(h.modern_meaning || '')
      + String(h.culture_imagery || '');
    var citIds = String(h.citation || '').split('|').filter(function (x) { return !!x; });

    function rank(c) {
      var name = c.semantic_name || '';
      var score = 0;
      if (name && String(c.content || '').indexOf(name) >= 0) { score += 10; }
      if (name && own.indexOf(name) >= 0) { score += 6; }
      if ((c.contribution || '') && own.indexOf(c.contribution) >= 0) { score += 4; }
      if (c.text_id && citIds.length && c.text_id === citIds[0]) { score += 8; }
      else if (c.text_id && citIds.indexOf(c.text_id) >= 0) { score += 3; }
      return score;
    }
    // Python: sorted(key=(-score, semantic_id))；JS 的 sort 稳定，同分保持原顺序，
    // 但为了让"同分按 semantic_id 排序"完全一致，这里显式比较第二个键。
    chain.sort(function (a, b) {
      var d = rank(b) - rank(a);
      if (d !== 0) { return d; }
      return a.semantic_id < b.semantic_id ? -1 : (a.semantic_id > b.semantic_id ? 1 : 0);
    });

    // 字库自带 citation（人工核校层）优先
    for (var i = 0; i < citIds.length; i++) {
      var tid = citIds[i];
      var t0 = kb.texts[tid];
      if (!t0 || !String(t0.content || '').trim()) { continue; }
      var cls0 = kb.classics[t0.classic_id];
      var sem0 = null;
      for (var j = 0; j < chain.length; j++) {
        if (chain[j].text_id === tid) { sem0 = chain[j].semantic_name; break; }
      }
      // 对应 Python: conflicts = [c for c in chain if c.text_id != tid and not (c['semantic_name'] or '') in own]
      var conflicts = chain.filter(function (c) {
        return c.text_id !== tid && own.indexOf(String(c.semantic_name || '')) < 0;
      });
      return {
        cites: { level: h.evidence_code || 'A', classic: cls0 ? cls0.name : null,
          chapter: t0.chapter, content: t0.content, semantic: sem0, text_id: tid, in_db: true },
        conflicts: conflicts
      };
    }
    var conflicts2 = chain.slice(1).filter(function (c) {
      var n = String(c.semantic_name || '');
      return own.indexOf(n) < 0 && String(c.content || '').indexOf(n) < 0;
    });
    if (chain.length) {
      var c0 = chain[0];
      return {
        cites: { level: 'A', classic: c0.classic, chapter: c0.chapter, content: c0.content,
          semantic: c0.semantic_name, text_id: c0.text_id, in_db: true },
        conflicts: conflicts2
      };
    }
    // 字库自带 citation：只有在原文库里真的存在才当作"可核验出处"
    for (var k = 0; k < citIds.length; k++) {
      var tid2 = citIds[k];
      var t = kb.texts[tid2];
      if (t) {
        var cls = kb.classics[t.classic_id];
        return {
          cites: { level: h.evidence_code || 'A', classic: cls ? cls.name : null,
            chapter: t.chapter, content: t.content, semantic: null, text_id: tid2, in_db: true },
          conflicts: conflicts2
        };
      }
    }
    return {
      cites: { level: h.evidence_code || 'C', classic: h.source_ref || null, chapter: null,
        content: null, semantic: null, text_id: null, in_db: false },
      conflicts: conflicts2
    };
  }

  /* 把分项得分还原成 0~1 供解释展示；未启用的维度返回 null。 */
  function scoreComponents(kb, detail) {
    var out = {};
    for (var i = 0; i < kb.dims.length; i++) {
      var d = kb.dims[i];
      var v = detail[d.dim_id];
      out[d.dimension] = (v === null || v === undefined) ? null : R.round(v / 100.0, 2);
    }
    return out;
  }

  function buildExplanation(kb, req, given, chars, principleHits, evidence, detail, warns,
                            factHits, borrowHits, notices) {
    var pidNames = principleHits.map(function (p) {
      return kb.principles[p[0]].name + '（' + kb.principles[p[0]].rule_meaning + '）';
    }).join('、');
    var lines = [];
    lines.push('【取名思路】姓氏“' + req.surname + '”，名“' + given + '”。本名以《左传·桓公六年》'
      + '五类命名原则为主线：' + pidNames + '。');
    if (factHits && factHits.length) {
      var seg = [];
      for (var i = 0; i < factHits.length; i++) {
        var fid = factHits[i][0], label = factHits[i][1], kind = factHits[i][2];
        var hitChars = [];
        for (var j = 0; j < chars.length; j++) {
          var cf = kb.charFact[chars[j].char_id] || {};
          if (Object.prototype.hasOwnProperty.call(cf, fid)) { hitChars.push(chars[j].char); }
        }
        if (hitChars.length) {
          seg.push('“' + req.birthFacts + '”属' + kind + '（' + label + '），已落在“'
            + hitChars.join('、') + '”字上');
        } else {
          seg.push('“' + req.birthFacts + '”属' + kind + '（' + label + '），本名取其' + label + '意境');
        }
      }
      lines.push('【命名依据·信】你提供的事实：' + seg.join('；')
        + '。这是《左传》所说“以名生为信”——以可核验的出生事实作为命名依据。');
    }
    if (req.borrowWords && req.borrowWords.length) {
      var hits = [];
      for (var b = 0; b < chars.length; b++) {
        if (SEL.charBorrowScore(chars[b], req.borrowWords) > 0) { hits.push(chars[b].char); }
      }
      lines.push('【命名依据·假】你希望借“' + req.borrowWords.join('、') + '”取义，命中字：'
        + (hits.length ? hits.join('、') : '本组合未直接落到该物，建议更换指定外物') + '。');
    }
    for (var ci = 0; ci < chars.length; ci++) {
      var h = chars[ci];
      var bc = bestCitation(kb, h.char_id);
      var cites = bc.cites, conflicts = bc.conflicts;
      var pdefs = kb.charPrinciple[h.char_id] || [];
      var wantPids = principleHits.map(function (x) { return x[0]; });
      var pids = pdefs.filter(function (pd) { return wantPids.indexOf(pd[0]) >= 0; })
        .map(function (pd) { return pd[0]; });
      var pname = pids.length
        ? pids.map(function (p) { return kb.principles[p].name; }).join('、') : '—';
      var basis = null;
      for (var pd2 = 0; pd2 < pdefs.length; pd2++) {
        if (pids.indexOf(pdefs[pd2][0]) >= 0) { basis = pdefs[pd2][1]; break; }
      }
      var segOne = '“' + h.char + '”（' + (h.pinyin || '—') + '，' + (h.strokes || 0) + '画，'
        + (h.structure || '—') + '结构）：' + (h.modern_meaning || h.persona_semantic || '—')
        + '。文化意象为' + (h.culture_imagery || '—') + '，人格语义为'
        + (h.persona_semantic || '—') + '。';
      if (basis) { segOne += '归属“' + pname + '”类，依据：' + basis + '。'; }
      if (cites.content) {
        segOne += '原文可核：《' + String(cites.classic || '').replace(/^《+|》+$/g, '') + '》'
          + normChapter(cites.chapter, cites.classic) + '“' + cites.content + '”。';
      } else if (cites.classic) {
        segOne += '文化出处：' + cites.classic + '（' + cites.level
          + '级证据；该处原文尚未录入 T02，故不作为逐条引文）。';
      } else {
        segOne += '出处属文化约定（' + cites.level + '级证据），未绑定单句原文。';
      }
      if (conflicts && conflicts.length) {
        segOne += '注：该字亦见于“' + conflicts[0].semantic_name + '”语境，本名取其'
          + (h.persona_semantic || h.culture_imagery || '主流') + '义。';
      }
      lines.push('· ' + segOne);
    }
    var chainTxt = [];
    for (var cj = 0; cj < chars.length; cj++) {
      var h2 = chars[cj];
      var bc2 = bestCitation(kb, h2.char_id).cites;
      if (bc2.content) {
        chainTxt.push(h2.char + ' ← ' + (bc2.semantic || '语义') + ' · 《'
          + String(bc2.classic || '').replace(/^《+|》+$/g, '') + '》'
          + normChapter(bc2.chapter, bc2.classic));
      } else if (bc2.classic) {
        chainTxt.push(h2.char + ' ← 文化语境 · ' + bc2.classic + '（原文未录入）');
      } else {
        chainTxt.push(h2.char + ' ← 文化约定（' + bc2.level + '级证据）');
      }
    }
    if (chainTxt.length) { lines.push('【证据链】' + chainTxt.join('；')); }
    var comp = scoreComponents(kb, detail);
    var compParts = [];
    Object.keys(comp).forEach(function (k) {
      var v = comp[k];
      compParts.push((v === null || v === undefined)
        ? (k + ' 未启用') : (k + ' ' + v.toFixed(2)));
    });
    lines.push('【分项参考】' + compParts.join('、'));
    if (req.gender && req.gender !== '中性') {
      lines.push('【性别倾向】按你选择的“' + req.gender + '”评估，本组合性别契合度 '
        + ((detail.S08 || 0) / 100.0).toFixed(2) + '（契合 1.00 / 中性 0.72 / 相反 0.35）。');
    }
    if (warns && warns.length) { lines.push('【提请注意】' + warns.join('；')); }
    if (notices && notices.length) { lines.push('【约束提示】' + notices.join('；')); }
    lines.push('【边界说明】本结果依《左传》五类原则与可解释的文化语义生成，不作命运、财富、'
      + '疾病等吉凶预测，也不涉及算卦起卦。');
    return lines.join('\n');
  }

  return {
    normChapter: normChapter,
    evidenceChain: evidenceChain,
    bestCitation: bestCitation,
    scoreComponents: scoreComponents,
    buildExplanation: buildExplanation
  };
});
