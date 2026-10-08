/* 知识库内存索引 —— KnowledgeBase.__init__ 的 JavaScript 移植。
 *
 * 注意：这不是"把表原样读进来"就完事。其中 charSemantics（字↔语义的关联）在 Python 里
 * 是一段**带过滤逻辑的构建过程**（engine.py:87-114）：语义原文要与字的 citation 对得上、
 * 或语义名出现在来源说明里、或命中人工白名单，只有满足其一才算"挂得上"。
 * 不照搬这段，S02 需求匹配度就会算出一堆无关命中——所以这里逐条照抄，并用对拍核对索引本身。
 *
 * 用法：
 *   浏览器：<script src="js/engine/kbindex.js"></script> → window.GDM.buildIndex(window.__KB__)
 *   Node  ：const build = require('./web/js/engine/kbindex.js'); const kb = build(require('./tools/load_kb.js'));
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMKbIndex = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 人工确认的"字↔语义"精确配对（engine.py:28 的 ALLOW_SPECIFIC，逐条一致）
  var ALLOW_SPECIFIC = {};
  [['知', 'SEM017'], ['山', 'SEM018'], ['明', 'SEM011'], ['思', 'SEM044'],
   ['笃', 'SEM045'], ['博', 'SEM045'], ['学', 'SEM045'], ['修', 'SEM041'],
   ['远', 'SEM041'], ['齐', 'SEM014'], ['善', 'SEM024'], ['正', 'SEM034'],
   ['行', 'SEM041'], ['生', 'SEM001']
  ].forEach(function (p) { ALLOW_SPECIFIC[p[0] + '|' + p[1]] = true; });

  function byId(rows, key) {
    var m = {};
    for (var i = 0; i < rows.length; i++) { m[rows[i][key]] = rows[i]; }
    return m;
  }

  function build(data) {
    var kb = { raw: data };
    // 版本信息（kb_version / knowledge_version / engine_version 都在这里）
    kb.meta = data._meta || {};

    kb.hanziRows = data.hanzi || [];
    kb.hanzi = byId(kb.hanziRows, 'char_id');
    kb.charByChar = {};
    for (var i = 0; i < kb.hanziRows.length; i++) {
      kb.charByChar[kb.hanziRows[i].char] = kb.hanziRows[i].char_id;
    }
    kb.tags = byId(data.demand_tag || [], 'tag_id');
    kb.semantic = byId(data.semantic || [], 'semantic_id');
    kb.texts = byId(data.original_text || [], 'text_id');
    kb.classics = byId(data.classic || [], 'classic_id');
    kb.principles = byId(data.naming_principle || [], 'principle_id');
    // 评分维度与权重（按 dim_id 排序，与 Python 的 ORDER BY dim_id 一致）
    kb.dims = (data.score_dimension || []).slice().sort(function (a, b) {
      return String(a.dim_id) < String(b.dim_id) ? -1 : (String(a.dim_id) > String(b.dim_id) ? 1 : 0);
    });

    // 五类归属
    kb.principleChars = {};      // pid -> [char_id]
    kb.charPrinciple = {};       // char_id -> [[pid, basis], ...]
    var pc = data.principle_char || [];
    for (var j = 0; j < pc.length; j++) {
      var r = pc[j];
      if (!kb.principleChars[r.principle_id]) { kb.principleChars[r.principle_id] = []; }
      kb.principleChars[r.principle_id].push(r.char_id);
      if (!kb.charPrinciple[r.char_id]) { kb.charPrinciple[r.char_id] = []; }
      kb.charPrinciple[r.char_id].push([r.principle_id, r.basis]);
    }

    // 字 ↔ 语义：与 engine.py:87-114 同样的三条路线过滤
    kb.charSemantics = {};       // char_id -> [item]
    var sc = data.semantic_char || [];
    for (var k = 0; k < sc.length; k++) {
      var row = sc[k];
      var h = kb.hanzi[row.char_id];
      var s = kb.semantic[row.semantic_id];
      if (!h || !s) { continue; }                       // 等价于 SQL 的 JOIN hanzi/semantic
      var own = [h.persona_semantic, h.culture_imagery, h.modern_meaning]
        .filter(function (x) { return !!x; }).join('');
      var citIds = {};
      String(h.citation || '').split('|').forEach(function (x) { if (x) { citIds[x] = true; } });
      var sname = s.name || '';
      var contrib = row.contribution || '';
      var srcRef = h.source_ref || '';
      // 路线一（强）：字的 citation 指向该语义的原文，且语义名/贡献与该字自述相符
      var route1 = !!s.text_id && !!citIds[s.text_id] && !!sname
        && (own.indexOf(sname) >= 0 || (contrib && own.indexOf(contrib) >= 0)
            || srcRef.indexOf(sname) >= 0);
      // 路线二（强）：语义名与来源说明完全一致
      var route2 = !!sname && srcRef.indexOf(sname) >= 0;
      // 路线三（人工确认）
      var route3 = !!ALLOW_SPECIFIC[h.char + '|' + row.semantic_id];
      if (!(route1 || route2 || route3)) { continue; }

      var item = {
        char_id: row.char_id, semantic_id: row.semantic_id,
        contribution: row.contribution, evidence_code: row.evidence_code,
        sname: s.name, text_id: s.text_id, verified: s.verified, description: s.description
      };
      if (!item.text_id && h.citation) {
        var first = String(h.citation).split('|').filter(function (x) { return !!x; });
        if (first.length) { item.text_id = first[0]; }
      }
      if (!kb.charSemantics[row.char_id]) { kb.charSemantics[row.char_id] = []; }
      kb.charSemantics[row.char_id].push(item);
    }

    // 出生事实词库（'信'类的落地依据）
    kb.facts = [];
    kb.factChar = {};            // fact_id -> {char_id: strength}
    kb.charFact = {};            // char_id -> {fact_id: strength}
    var fl = data.fact_lexicon || [];
    for (var f = 0; f < fl.length; f++) {
      var fd = {};
      for (var key in fl[f]) { if (Object.prototype.hasOwnProperty.call(fl[f], key)) { fd[key] = fl[f][key]; } }
      fd.keywords = String(fl[f].keywords || '').split(',').filter(function (x) { return !!x; });
      kb.facts.push(fd);
    }
    (data.fact_char || []).forEach(function (r) {
      if (!kb.factChar[r.fact_id]) { kb.factChar[r.fact_id] = {}; }
      kb.factChar[r.fact_id][r.char_id] = r.strength;
      if (!kb.charFact[r.char_id]) { kb.charFact[r.char_id] = {}; }
      kb.charFact[r.char_id][r.fact_id] = r.strength;
    });

    // 目标标签 ↔ 字义亲和力（profile=贴切 / avoid=冲突）
    kb.affinity = {};            // tag_id -> {profile: [...], avoid: [...]}
    (data.goal_affinity || []).forEach(function (r) {
      if (!kb.affinity[r.tag_id]) { kb.affinity[r.tag_id] = { profile: [], avoid: [] }; }
      if (r.kind === 'profile' || r.kind === 'avoid') {
        kb.affinity[r.tag_id][r.kind].push(r.cue);
      }
    });

    // 《左传》六忌用字（软提示，不淘汰）
    kb.taboo = {};
    (data.taboo_char || []).forEach(function (r) {
      kb.taboo[r.char_id] = { kind: r.kind, note: r.note };
    });

    // 意象选项 → 字族线索（ORDER BY cue_id，顺序与 Python 一致）
    kb.imageryCues = {};         // option -> [{label, keywords:[], chars:{char:true}}]
    kb.imageryCueOptions = [];
    var cues = (data.imagery_cue || []).slice().sort(function (a, b) {
      return String(a.cue_id) < String(b.cue_id) ? -1 : (String(a.cue_id) > String(b.cue_id) ? 1 : 0);
    });
    for (var c2 = 0; c2 < cues.length; c2++) {
      var r2 = cues[c2];
      var opt = r2.option;
      if (!kb.imageryCues[opt]) { kb.imageryCues[opt] = []; kb.imageryCueOptions.push(opt); }
      var charSet = {};
      String(r2.chars || '').split('').forEach(function (ch) { if (ch) { charSet[ch] = true; } });
      kb.imageryCues[opt].push({
        label: r2.label,
        keywords: String(r2.keywords || '').split(',').filter(function (x) { return !!x; }),
        chars: charSet
      });
    }

    // 风险词表：按 kind 分组（kind 的先后 = 表内出现顺序，Python 的 dict 同理）
    kb.risk = {};
    (data.risk_lexicon || []).forEach(function (r) {
      if (!kb.risk[r.kind]) { kb.risk[r.kind] = {}; }
      kb.risk[r.kind][r.term] = r;
    });

    // 谐音词表：按音节数 + 拼音建索引（Python 里为避免逐候选扫全表）
    kb.homophone = (data.homophone_word || []).slice();
    kb.hpExact = {};
    kb.hpLoose = {};
    kb.homophone.forEach(function (d) {
      var n = d.syllables;
      if (!kb.hpExact[n]) { kb.hpExact[n] = {}; kb.hpLoose[n] = {}; }
      if (kb.hpExact[n][d.pinyin] === undefined) { kb.hpExact[n][d.pinyin] = d; }
      if (kb.hpLoose[n][d.pinyin_loose] === undefined) { kb.hpLoose[n][d.pinyin_loose] = d; }
    });

    return kb;
  }

  return { build: build, ALLOW_SPECIFIC: ALLOW_SPECIFIC };
});
