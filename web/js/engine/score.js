/* 候选评分 —— engine.py:1138-1349 score_candidate + 1012-1040 两个小工具 的移植。
 *
 * 输出与 Python 一致的三样：总分（round 到 1 位）、分项 detail（含未启用维度为 null）、
 * 提示 notes（顺序与文案都要一致）。
 *
 * 几个必须照抄的点：
 *   · 每个分项都用 Python 的 round(x,1)（四舍六入五成双），见 pyround.js；
 *   · S07 权重为 0 且 scope=explore，不参与总分（但它仍要出现在 detail 里）；
 *   · S11 不是加权项，而是**乘数**（冲突 ×0.45 / 未命中 ×0.72 / 达标 ×1.06）；
 *   · S09 只在"信"识别出事实时启用，S10 只在给了借物词时启用。
 *
 * 用法：const { scoreCandidate } = require('./web/js/engine/score.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMScore = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // factory 的作用域里没有外层 IIFE 的 root 参数，必须自己取一次全局对象，
  // 否则浏览器路径下的 dep() 会 ReferenceError（Node 路径走 require，永远看不到）
  var root = (typeof globalThis !== 'undefined') ? globalThis : this;

  function dep(name) {
    if (typeof module === 'object' && module.exports) { return require('./' + name + '.js'); }
    // 浏览器模式靠全局变量取依赖。这张表必须**列全**：score.js 用到 select.js 的
    // charBorrowScore，而 'select' 曾经漏在这张表外——Node 下走 require 一切正常，
    // 只有浏览器里会拿到 undefined 然后在运行时炸掉。加依赖时记得同步这里。
    return root[{ prng: 'GDMRandom', affinity: 'GDMAffinity', phonetics: 'GDMPhonetics',
      pyround: 'GDMPyRound', surnames: 'GDMSurnames', textmatch: 'GDMText',
      select: 'GDMSelect' }[name]];
  }
  var R = dep('pyround');
  var AFF = dep('affinity');
  var PH = dep('phonetics');
  var SN = dep('surnames');
  var TX = dep('textmatch');
  var FACT_W = { strong: 1.0, medium: 0.7, weak: 0.4 };

  /* 文化意象归入大类（engine.py:1012-1033）。
     注意：关键词是**字符串**（有 '植物' '器物' '明光' '光明/兴盛' 这种多字词），
     必须按整词做包含匹配。曾把它拍平成"字符集合"逐个字判，结果 '器物' 里的 '物'
     命中了「植物」类，导致组合互补度算错、提示文案也跟着错。 */
  var IMAGERY_TABLE = [
    ['水', ['水', '泽', '江', '河', '湖', '海', '川', '雨', '露', '霜', '雪', '霖', '溪']],
    ['天文', ['天', '云', '月', '星', '辰', '风', '光', '日', '曦', '晖', '曜', '霄', '明光',
      '虹', '霞', '霓']],
    ['植物', ['植物', '木', '艹', '竹', '兰', '梅', '菊', '荷', '松', '香草']],
    ['动物', ['动物', '鸟', '鹤', '鹏', '鸿']],
    ['山水', ['山', '岳', '峰', '峻']],
    ['玉石器物', ['玉', '石', '器物', '礼', '空间']],
    ['德性', ['德', '修身', '信', '孝', '品格', '坤', '乾', '艮', '志', '远', '进取', '学', '思', '文']],
    ['安和', ['安', '宁', '和', '定', '静', '淡', '素', '玄']],
    ['生长', ['生', '新', '初', '春', '成长', '光明/兴盛']],
    ['家族', ['家', '族', '承']],
    ['智慧', ['智']],
    ['时序', ['时序']]
  ];

  function imageryCat(v) {
    if (!v) { return ''; }
    var s = String(v);
    for (var i = 0; i < IMAGERY_TABLE.length; i++) {
      var keys = IMAGERY_TABLE[i][1];
      for (var k = 0; k < keys.length; k++) {
        if (s.indexOf(keys[k]) >= 0) { return IMAGERY_TABLE[i][0]; }
      }
    }
    return s;
  }

  /* 高频字堆叠（子涵/梓萱 类模板感）降独特性 */
  var HOT = '涵轩萱梓子欣怡雨语思佳嘉怡晨宸';
  function templatePenalty(chars) {
    var n = 0;
    for (var i = 0; i < chars.length; i++) { if (HOT.indexOf(chars[i].char) >= 0) { n++; } }
    return n === 0 ? 1.0 : (n === 1 ? 0.75 : 0.45);
  }

  function scoreCandidate(kb, req, given, chars, principleHits, goalTags, factIdSet, avoidCues) {
    var detail = {}, notes = [];
    factIdSet = factIdSet || {};
    avoidCues = avoidCues || [];
    var i, h;

    // ---- S01 文化证据度 ----
    var EV_NUM = { 'A': 1.0, 'B': 0.6, 'C': 0.25 };
    var evScores = [], verifiedCnt = 0;
    for (i = 0; i < chars.length; i++) {
      h = chars[i];
      var ev = EV_NUM[h.evidence_code];
      evScores.push(ev === undefined ? 0.25 : ev);
      if (h.citation_status === 'verified' && h.citation) { verifiedCnt++; }
    }
    var baseEv = evScores.length
      ? evScores.reduce(function (a, b) { return a + b; }, 0) / evScores.length : 0.25;
    var cov = chars.length ? verifiedCnt / chars.length : 0;
    var srcs = {};
    for (i = 0; i < chars.length; i++) {
      var cs = kb.charSemantics[chars[i].char_id] || [];
      for (var j = 0; j < cs.length; j++) { if (cs[j].text_id) { srcs[cs[j].text_id] = true; } }
    }
    var multiSrc = Object.keys(srcs).length >= 2 ? 1.0 : 0.0;
    detail.S01 = R.round(100 * Math.min(1.0, 0.52 * baseEv + 0.34 * cov + 0.14 * multiSrc), 1);
    if (verifiedCnt === chars.length) { notes.push('两个字都有可核验原文出处'); }
    else if (verifiedCnt === 0) { notes.push('本组合暂无逐条核验的原文出处，出处文化语境'); }

    // ---- S02 需求匹配度 ----
    var tagText = '', tagImagery = '', tagSem = '', tagClassic = '';
    for (i = 0; i < (goalTags || []).length; i++) {
      var t = kb.tags[goalTags[i]];
      if (!t) { continue; }
      tagText += (t.semantic_map || '') + '、';
      tagImagery += (t.imagery_hint || '') + '、';
      tagSem += (t.user_phrase || '') + '、';
      tagClassic += (t.classic_hint || '') + '、';
    }
    var s2 = TX.demandMatch(chars, kb, tagText, tagImagery, tagSem, tagClassic);
    detail.S02 = (goalTags && goalTags.length) ? R.round(100 * s2, 1) : null;

    // ---- S08 性别倾向契合度 ----
    var gSum = 0;
    for (i = 0; i < chars.length; i++) { gSum += genderOf(chars[i], req.gender); }
    detail.S08 = R.round(100 * (gSum / chars.length), 1);

    // ---- S09 命名依据（信）契合度 ----
    var fSum = 0;
    for (i = 0; i < chars.length; i++) { fSum += factStrength(kb, chars[i].char_id, factIdSet); }
    detail.S09 = Object.keys(factIdSet).length ? R.round(100 * (fSum / chars.length), 1) : null;

    // ---- S03 音律 ----
    var sp = SN.TABLE[req.surname];
    var spy = sp ? sp[0] : null, stone = sp ? sp[1] : null;
    var tones = [stone];
    for (i = 0; i < chars.length; i++) { tones.push(chars[i].tone); }
    var tScore = PH.scoreToneSequence(tones);
    var flow = PH.scorePhoneticFlow(spy, chars[0].pinyin,
      chars.length > 1 ? chars[1].pinyin : '');
    detail.S03 = R.round(100 * (0.6 * tScore + 0.4 * flow.score), 1);
    for (i = 0; i < flow.notes.length; i++) { notes.push(flow.notes[i]); }
    if (stone) {
      var toneTxt = '';
      for (i = 1; i < tones.length; i++) {
        if (tones[i]) { toneTxt += PH.toneName(tones[i]); }
      }
      notes.push('声调：' + req.surname + toneTxt);
    }

    // ---- S04 字形 ----
    var strokes = [], structures = [], rares = [];
    for (i = 0; i < chars.length; i++) {
      strokes.push(chars[i].strokes); structures.push(chars[i].structure);
      rares.push(chars[i].rare_code);
    }
    var gl = PH.scoreGlyph(strokes, structures, rares);
    detail.S04 = R.round(100 * gl.score, 1);
    for (i = 0; i < gl.notes.length; i++) { notes.push(gl.notes[i]); }

    // ---- S05 现代适配度 ----
    var CM = { '高': 1.0, '中': 0.75, '低': 0.45 };
    var HR = { '低': 1.0, '中': 0.7, '高': 0.2 };
    var s5 = 0;
    for (i = 0; i < chars.length; i++) {
      var c = CM[chars[i].commonness_code]; s5 += (c === undefined ? 0.6 : c);
    }
    s5 = s5 / chars.length;
    var hrSum = 0;
    for (i = 0; i < chars.length; i++) {
      var v = HR[chars[i].homophone_risk_code]; hrSum += (v === undefined ? 0.8 : v);
    }
    s5 = 0.5 * s5 + 0.5 * (hrSum / chars.length);
    detail.S05 = R.round(100 * s5, 1);

    // ---- S06 组合互补度 ----
    if (chars.length < 2) {
      detail.S06 = 70.0;
      notes.push('单字名：无组合互补维度，评分按中性处理');
    } else {
      var roleTerms = [];
      for (i = 0; i < chars.length; i++) {
        var set = {};
        var toks = String(chars[i].persona_semantic || '') + '、'
          + String(chars[i].culture_imagery || '');
        toks.split(/[、,，/／;；\s]+/).forEach(function (tok) { if (tok) { set[tok] = true; } });
        roleTerms.push(set);
      }
      var sim = 0.0;
      var k0 = Object.keys(roleTerms[0]), k1 = Object.keys(roleTerms[1]);
      if (k0.length && k1.length) {
        var inter = 0;
        for (i = 0; i < k0.length; i++) { if (roleTerms[1][k0[i]]) { inter++; } }
        sim = inter / Math.min(k0.length, k1.length);
      }
      var t1 = {}, t2 = {};
      (kb.charSemantics[chars[0].char_id] || []).forEach(function (c) {
        if (c.text_id) { t1[c.text_id] = true; } });
      (kb.charSemantics[chars[1].char_id] || []).forEach(function (c) {
        if (c.text_id) { t2[c.text_id] = true; } });
      var overlapKeys = Object.keys(t1).filter(function (k) { return t2[k]; });
      var srcOverlap = (Object.keys(t1).length && Object.keys(t2).length && overlapKeys.length)
        ? 1.0 : 0.0;
      var cat1 = imageryCat(chars[0].culture_imagery);
      var cat2 = imageryCat(chars[1].culture_imagery);
      var sameCat = !!cat1 && cat1 === cat2;
      // 与 Python 一致：关键词是**词**（'修身' '品格' '进取' '植物' '器物' '天文'），
      // 必须整词匹配。曾把它拍平成字符串逐字判，于是 '文' 命中了 '天文'，
      // 让"虚实搭配"多加了 0.08（S06 由 86 变 94），连候选顺序都改了。
      var ABSTRACT = ['德', '修身', '品格', '志', '进取', '学', '思', '文', '安', '宁', '和'];
      var CONCRETE = ['水', '植物', '动物', '山', '玉', '器物', '天文', '光', '雨', '雪'];
      var ci0 = String(chars[0].culture_imagery), ci1 = String(chars[1].culture_imagery);
      function hasAny(s, kws) {
        for (var q = 0; q < kws.length; q++) { if (s.indexOf(kws[q]) >= 0) { return true; } }
        return false;
      }
      var aAbs = hasAny(ci0, ABSTRACT), aCon = hasAny(ci0, CONCRETE);
      var bAbs = hasAny(ci1, ABSTRACT), bCon = hasAny(ci1, CONCRETE);
      var mix = (aAbs && bCon) || (aCon && bAbs);
      var s6 = 0.72;
      s6 += 0.22 * (1.0 - sim);
      s6 += 0.10 * (1.0 - srcOverlap);
      if (sameCat) { s6 -= 0.18; }
      else if (cat1 && cat2) { s6 += 0.12; }
      else { s6 -= 0.06; }
      if (mix) { s6 += 0.08; }
      detail.S06 = R.round(100 * Math.max(0.0, Math.min(1.0, s6)), 1);
      if (sim >= 0.8) { notes.push('两字语义高度重合，寓意层次偏单薄'); }
      else if (srcOverlap && detail.S06 < 60) {
        notes.push('两字语义同出一句，属于同源堆叠，建议换掉一个字');
      } else if (sameCat) { notes.push('两字意象同属“' + cat1 + '”一类，层次略单'); }
      else if (detail.S06 >= 85) {
        notes.push('两字语义跨类互补（' + cat1 + ' × ' + cat2 + '），层次分明');
      }
    }

    // ---- S07 独特性 ----
    var UNIQ = { '高': 0.35, '中': 0.85, '低': 1.0 };
    var uniqSum = 0;
    for (i = 0; i < chars.length; i++) {
      var u = UNIQ[chars[i].commonness_code]; uniqSum += (u === undefined ? 0.6 : u);
    }
    detail.S07 = R.round(100 * (uniqSum / chars.length) * templatePenalty(chars), 1);

    // ---- S10 借物契合度 ----
    var SC = dep('select');
    if (req.borrowWords && req.borrowWords.length) {
      var bRaw = [];
      for (i = 0; i < chars.length; i++) { bRaw.push(SC.charBorrowScore(chars[i], req.borrowWords)); }
      var strongest = bRaw.length ? Math.max.apply(null, bRaw) : 0.0;
      var nHit = bRaw.filter(function (x) { return x > 0; }).length;
      if (strongest >= 2.0) { detail.S10 = nHit >= 2 ? 100.0 : 92.0; }
      else if (strongest >= 1.0) { detail.S10 = nHit >= 2 ? 100.0 : 78.0; }
      else { detail.S10 = 0.0; }
      if (chars.length && nHit === 0) {
        notes.push('本组合未落到指定的外物（' + req.borrowWords.join('、') + '）上');
      } else if (nHit) {
        var carried = [];
        for (i = 0; i < chars.length; i++) { if (bRaw[i] > 0) { carried.push(chars[i].char); } }
        notes.push('借“' + req.borrowWords.join('、') + '”之义由“' + carried.join('、') + '”承载');
      }
    } else {
      detail.S10 = null;
    }

    // ---- S11 目标契合度（作为乘数，不是加权项）----
    if (goalTags && goalTags.length) {
      var ga = AFF.goalAffinity(kb, goalTags);
      var prof = ga.profile;
      var nConf = 0, hit = 0;
      for (i = 0; i < chars.length; i++) {
        if (AFF.charConflicts(chars[i], avoidCues)) { nConf++; }
      }
      for (i = 0; i < chars.length; i++) {
        var own = String(chars[i].persona_semantic || '') + String(chars[i].culture_imagery || '')
          + String(chars[i].modern_meaning || '');
        var anyHit = false;
        for (var pi = 0; pi < prof.length; pi++) {
          if (prof[pi] && own.indexOf(prof[pi]) >= 0) { anyHit = true; break; }
        }
        if (anyHit) { hit++; }
      }
      detail.S11 = chars.length
        ? Math.max(0.0, R.round(100.0 * hit / chars.length - 45.0 * nConf, 1)) : 0.0;
      detail.S11_conflict = nConf ? 1 : 0;
      if (nConf) {
        var hitCh = [];
        for (i = 0; i < chars.length; i++) {
          if (AFF.charConflicts(chars[i], avoidCues)) { hitCh.push(chars[i].char); }
        }
        notes.push('“' + hitCh.join('、') + '”与你选的目标（' + ga.labels.join('、')
          + '）气质不符，已降权');
      } else if (hit === 0) {
        notes.push('该组合未直接命中你选的目标（' + ga.labels.join('、') + '）的语义方向');
      }
    } else {
      detail.S11 = null;
    }

    // ---- 加权总分 ----
    var total = 0.0, wsum = 0.0;
    for (i = 0; i < kb.dims.length; i++) {
      var d = kb.dims[i];
      if (d.scope !== 'core') { continue; }
      var val = detail[d.dim_id];
      if (val === null || val === undefined) { continue; }
      total += val * d.weight;
      wsum += d.weight;
    }
    var extra = [];
    if (req.gender && req.gender !== '中性') { extra.push(['S08', 0.18]); }
    if (detail.S09 !== null && detail.S09 !== undefined) { extra.push(['S09', 0.20]); }
    if (detail.S10 !== null && detail.S10 !== undefined) { extra.push(['S10', 0.30]); }
    for (i = 0; i < extra.length; i++) {
      var kk = extra[i][0], ww = extra[i][1];
      total += (detail[kk] || 0) * ww;
      wsum += ww;
    }
    var score = wsum ? total / wsum : 0;
    if (detail.S11 !== null && detail.S11 !== undefined) {
      var s11 = detail.S11;
      if (detail.S11_conflict) { score *= 0.45; }
      else if (s11 <= 0) { score *= 0.72; }
      else if (s11 >= 60) { score *= 1.06; }
    }
    return { score: R.round(score, 1), detail: detail, notes: notes };
  }

  function genderOf(h, gender) {
    var b = h.gender_bias || '中性';
    if (!gender || gender === '中性') { return b === '中性' ? 0.72 : 0.6; }
    var want = (gender === '女' || gender === '偏女性' || gender === '女性') ? '偏女性' : '偏男性';
    var other = want === '偏女性' ? '偏男性' : '偏女性';
    if (b === want) { return 1.0; }
    if (b === other) { return 0.35; }
    return 0.72;
  }

  function factStrength(kb, charId, factIdSet) {
    var m = kb.charFact[charId] || {};
    var best = 0.0;
    for (var k in m) {
      if (!Object.prototype.hasOwnProperty.call(m, k)) { continue; }
      if (factIdSet[k]) {
        var w = FACT_W[m[k]]; if (w === undefined) { w = 0.4; }
        if (w > best) { best = w; }
      }
    }
    return best;
  }

  return {
    scoreCandidate: scoreCandidate,
    imageryCat: imageryCat,
    templatePenalty: templatePenalty,
    HOT: HOT
  };
});
