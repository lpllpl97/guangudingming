/* 选字与排序 —— engine.py:280-376（事实/借物）+ 427-438（性别）+ 754-931（select_chars）的移植。
 *
 * 这是"候选顺序能否完全一致"的关键一片：
 *   · pool 按优先级构造（必用字 → 意象字族 → 目标贴合字 → 借物字 → 原则池）
 *   · rank 是一个 12 元组，逐字段决定排序；末尾用 char_id 兜底（TEXT，如 Z0001）
 *   · 同档字按种子打散：seed ^ 0x5EED 驱动 shuffle —— 注意必须用无符号异或，
 *     否则种子第 31 位为 1 时 JS 会得到负数，而 Python 得到的是 2^32 内的正数（两者会分叉）。
 *
 * 用法：const { selectChars } = require('./web/js/engine/select.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMSelect = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var FACT_W = { strong: 1.0, medium: 0.7, weak: 0.4 };

  // 借物关联族（engine.py:314-350 逐条一致；含「假」专用的人造之物族）
  var BORROW_FAMILY = {
    '玉': '玉瑾瑜珩瑶琼璐珊琳玥珮琚璧璋圭琛瑄玦珅玙璞玑琢瑞',
    '兰': '兰芷蕙荃蘅荪葳',
    '竹': '竹筠简笙箫箦笔',
    '松': '松柏',
    '舟': '舟帆楫棹舷航',
    '砚': '砚墨笔笺简篆铭案函',
    '琴': '琴瑟弦徽磬笙箫钟鼓',
    '鼎': '鼎尊爵彝铉鉴',
    '镜': '鉴镜',
    '水': '水清澄渊川江海澜泓溪沅湘沐湛澈汐湄漪淮',
    '山': '山岳峰岑岩峻岚嵩岱',
    '月': '月露霜雪晴霓霁霞',
    '云': '云舒霄霞霓雯',
    '星': '星辰曜晖昭曦昕旭晞旸昀',
    '花': '兰芷蕙梅荷莲菊桂桃棠薇菀茉蕊蕾萱菱菡荃蘅荪',
    '草': '兰芷蕙薇菀苓芝荃蘅荪葳芃',
    '木': '松柏桐梧杉桂梅棠槐林森柳',
    '光': '明昭晖曜曦旭朗华辉炜烨煜灿耀熙昱',
    '风': '云舒朗岚',
    '雨': '霖泽润霁澄沐溦霈',
    '雪': '雪霜素霁梅',
    '文': '文章学思书墨笔简典雅',
    '德': '德仁义礼智信诚善正谦和',
    // ---- 「假」专用的人造之物族 ----
    '玉器': '玉瑾瑜珩瑶琼璐珊琳玥璧璋圭琮璜琛瑄玦珅玙璞玑琢瑞瑛玮璟',
    '佩饰': '佩珮琚瑗环玦瑱璎珂玖组绶',
    '礼器': '鼎尊爵彝铉鉴簋觞瓒珪鬲甑',
    '乐器': '琴瑟弦徽磬笙箫钟鼓筝笛箜',
    '文房': '砚墨笔笺简篆铭案函卷纸帖',
    '舟楫': '舟帆楫棹舷航舸橹桅',
    '织绣': '绫绮绡缇缦缜绦缳裳绾缃缥纾罗绢'
  };

  /* 借物匹配分 0~2：2=字本身就是该物，1=同族或字义直接涉及，0=未命中。
     "文化意象"这类宽泛字段不参与，否则借"玉"会匹配到所有玉石意象字。 */
  function charBorrowScore(h, borrowWords) {
    if (!borrowWords || !borrowWords.length) { return 0.0; }
    var ch = h.char || '';
    var meaning = String(h.modern_meaning || '') + String(h.persona_semantic || '');
    var best = 0.0;
    for (var i = 0; i < borrowWords.length; i++) {
      var w = borrowWords[i];
      if (!w) { continue; }
      if (w === ch) { return 2.0; }
      var fam = BORROW_FAMILY[w] || '';
      if (ch && fam.indexOf(ch) >= 0) { if (best < 1.0) { best = 1.0; } continue; }
      if (meaning.indexOf(w) >= 0) { if (best < 1.0) { best = 1.0; } }
    }
    return best;
  }

  function charBorrowHit(h, borrowWords) { return charBorrowScore(h, borrowWords) > 0; }

  /* 事实映射：返回 [[fact_id, label, kind, 命中关键词, [char_id...]], ...]，
     按命中关键词长度降序、fact_id 升序；被更具体事实覆盖的条目丢弃；最多 3 条。 */
  function matchFacts(kb, text) {
    if (!text) { return []; }
    var hits = [];
    for (var i = 0; i < kb.facts.length; i++) {
      var f = kb.facts[i];
      var matched = f.keywords.filter(function (k) { return k && text.indexOf(k) >= 0; });
      if (!matched.length) { continue; }
      matched.sort(function (a, b) { return b.length - a.length; });
      var ids = Object.keys(kb.factChar[f.fact_id] || {}).sort();
      hits.push([f.fact_id, f.label, f.kind, matched[0], ids]);
    }
    hits.sort(function (a, b) {
      if (b[3].length !== a[3].length) { return b[3].length - a[3].length; }
      return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
    });
    var keep = [], used = {};
    for (var j = 0; j < hits.length; j++) {
      var h = hits[j];
      var idset = h[4];
      var subset = idset.length > 0;
      for (var k = 0; k < idset.length; k++) { if (!used[idset[k]]) { subset = false; break; } }
      if (subset && idset.length < 6) { continue; }
      keep.push(h);
      for (var m = 0; m < idset.length; m++) { used[idset[m]] = true; }
    }
    return keep.slice(0, 3);
  }

  /* 性别倾向契合度：契合 1.0 / 中性 0.72 / 相反 0.35 */
  function charGenderScore(h, gender) {
    var b = h.gender_bias || '中性';
    if (!gender || gender === '中性') { return b === '中性' ? 0.72 : 0.6; }
    var want = (gender === '女' || gender === '偏女性' || gender === '女性') ? '偏女性' : '偏男性';
    var other = want === '偏女性' ? '偏男性' : '偏女性';
    if (b === want) { return 1.0; }
    if (b === other) { return 0.35; }
    return 0.72;
  }

  /* 排序元组比较：前 11 个字段数值升序，最后按 char_id 字符串升序。 */
  function cmpRank(a, b) {
    for (var i = 0; i < 11; i++) {
      if (a[i] !== b[i]) { return a[i] < b[i] ? -1 : 1; }
    }
    return a[11] < b[11] ? -1 : (a[11] > b[11] ? 1 : 0);
  }

  /* 排序元组（engine.py:887-909 逐字段对应）。
     抽成导出的纯函数，是为了能逐字段对拍——只比最终顺序的话，
     某个字段算错会被别的字段掩盖，很难定位。 */
  function rankOf(kb, req, cid, ctx) {
    var AFF = ctx.AFF;
    var h = kb.hanzi[cid];
    var styleHit = req.styles.indexOf(h.style) >= 0 ? 1 : 0;
    var mustFlag = ctx.mustSet[h.char] ? 1 : 0;
    var fs = ctx.factStrength(cid);
    var g = charGenderScore(h, req.gender);
    var bs = charBorrowScore(h, req.borrowWords);
    var borrow = bs > 0 ? 1 : 0;
    var conflict = 0;
    var own = String(h.persona_semantic || '') + '、' + String(h.culture_imagery || '')
      + '、' + String(h.modern_meaning || '');
    for (var i = 0; i < ctx.avoidCues.length; i++) {
      var cue = ctx.avoidCues[i];
      if (cue && own.indexOf(cue) >= 0) { conflict = 1; break; }
    }
    var cueV = AFF.imageryAffinity(h, ctx.cueSpecs);
    var prof = (ctx.profCues.length && AFF.charProfileHit(h, ctx.profCues)) ? 1 : 0;
    var commonness = COMMONNESS[h.commonness_code];
    if (commonness === undefined) { commonness = 0; }
    var ev = h.evidence_code === 'A' ? 2 : (h.evidence_code === 'B' ? 1 : 0);
    return [-mustFlag, conflict, -r2(cueV), -prof, -borrow, -r2(bs), -r2(g),
      -r2(fs), -styleHit, -ev, -commonness, cid];
  }

  // 与 Python round(x, 2) 对齐：本项目参与排序的值都只有 0~2 位小数，故等价
  var COMMONNESS = { '高': 2, '中': 1, '低': 0 };
  function r2(x) { return Math.round(x * 100) / 100; }

  /* 组装 rankOf 需要的上下文（与 selectChars 内部用的完全同一份逻辑）。
     导出它是为了让对拍能逐字段比排序元组——只比最终顺序时，
     某个字段算错会被别的字段掩盖。 */
  function makeRankCtx(kb, req, opts) {
    opts = opts || {};
    var AFF = opts.AFF || ((typeof module === 'object' && module.exports)
      ? require('./affinity.js') : root.GDMAffinity);
    var mustSet = {};
    (req.fixedChars || []).forEach(function (c) { if (c) { mustSet[c] = true; } });
    if (req.generationChar) {
      String(req.generationChar).split('').forEach(function (c) { if (c) { mustSet[c] = true; } });
    }
    var pids = (opts.pids || []);
    var matchedFacts = pids.indexOf('F01') >= 0 ? matchFacts(kb, req.birthFacts) : [];
    var factIdSet = {};
    matchedFacts.forEach(function (f) { factIdSet[f[0]] = true; });
    function factStrength(cid) {
      var m = kb.charFact[cid] || {};
      var best = 0.0, any = false;
      for (var k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) { continue; }
        if (factIdSet[k]) {
          any = true;
          var w = FACT_W[m[k]]; if (w === undefined) { w = 0.4; }
          if (w > best) { best = w; }
        }
      }
      return any ? best : 0.0;
    }
    return {
      AFF: AFF, mustSet: mustSet, avoidCues: opts.avoidCues || [],
      cueSpecs: opts.cueSpecs || [], profCues: opts.profCues || [],
      factStrength: factStrength, factIdSet: factIdSet, matchedFacts: matchedFacts
    };
  }

  function selectChars(kb, req, principleHits, opts) {
    opts = opts || {};
    var PRNG = (typeof module === 'object' && module.exports)
      ? require('./prng.js') : root.GDMRandom;
    var AFF = (typeof module === 'object' && module.exports)
      ? require('./affinity.js') : root.GDMAffinity;

    var poolLimit = opts.poolLimit === undefined ? 70 : opts.poolLimit;
    var avoidCues = opts.avoidCues || [];
    var cueSpecs = opts.cueSpecs || [];
    var profCues = opts.profCues || [];

    var pids = principleHits.map(function (p) { return p[0]; });
    var mustSet = {};
    (req.fixedChars || []).forEach(function (c) { if (c) { mustSet[c] = true; } });
    if (req.generationChar) {
      String(req.generationChar).split('').forEach(function (c) { if (c) { mustSet[c] = true; } });
    }

    var matchedFacts = pids.indexOf('F01') >= 0 ? matchFacts(kb, req.birthFacts) : [];
    var factIdSet = {};
    matchedFacts.forEach(function (f) { factIdSet[f[0]] = true; });
    var factIds = [], seenF = {};
    matchedFacts.forEach(function (f) {
      f[4].forEach(function (cid) {
        if (!seenF[cid]) { seenF[cid] = true; factIds.push(cid); }
      });
    });

    var pool = [], seen = {};
    function push(cid) {
      if (cid !== undefined && cid !== null && !seen[cid]) { seen[cid] = true; pool.push(cid); }
    }

    if (factIds.length) {
      factIds.forEach(push);
      if (pool.length < 8) {
        pids.forEach(function (pid) {
          (kb.principleChars[pid] || []).forEach(push);
        });
      }
      pids.forEach(function (pid) {
        if (pid === 'F01') { return; }
        (kb.principleChars[pid] || []).slice(0, 24).forEach(push);
      });
    } else {
      if (req.borrowWords && req.borrowWords.length) {
        kb.hanziRows.forEach(function (h) {
          if (charBorrowScore(h, req.borrowWords) > 0) { push(h.char_id); }
        });
      }
      pids.forEach(function (pid) {
        (kb.principleChars[pid] || []).forEach(push);
      });
      if (pool.length < 12) {
        var extra = Object.keys(kb.charSemantics).sort(function (a, b) {
          return kb.charSemantics[b].length - kb.charSemantics[a].length;
        });
        for (var i = 0; i < extra.length; i++) {
          push(extra[i]);
          if (pool.length >= 20) { break; }
        }
      }
    }

    // 意象字族 / 目标贴合字：从全字库召回（否则意象与目标只是"一句备注"）
    var COMMON = { '高': 0, '中': 1, '低': 2 };
    if (cueSpecs && cueSpecs.length) {
      var cueExtra = [];
      kb.hanziRows.forEach(function (h) {
        if (AFF.imageryAffinity(h, cueSpecs) > 0) { cueExtra.push(h.char_id); }
      });
      cueExtra.sort(function (a, b) {
        var d = AFF.imageryAffinity(kb.hanzi[b], cueSpecs) - AFF.imageryAffinity(kb.hanzi[a], cueSpecs);
        if (d !== 0) { return d; }
        var ca = COMMON[kb.hanzi[a].commonness_code]; if (ca === undefined) { ca = 1; }
        var cb = COMMON[kb.hanzi[b].commonness_code]; if (cb === undefined) { cb = 1; }
        return ca - cb;
      });
      cueExtra.forEach(push);
    }
    if (profCues && profCues.length) {
      var profExtra = [];
      kb.hanziRows.forEach(function (h) {
        if (AFF.charProfileHit(h, profCues)) { profExtra.push(h.char_id); }
      });
      profExtra.sort(function (a, b) {
        var ca = COMMON[kb.hanzi[a].commonness_code]; if (ca === undefined) { ca = 1; }
        var cb = COMMON[kb.hanzi[b].commonness_code]; if (cb === undefined) { cb = 1; }
        return ca - cb;
      });
      profExtra.forEach(push);
    }

    // 必用字/字辈字必须先进入池（否则"固定字"约束会静默失效）
    var must = (req.fixedChars || []).slice();
    if (req.generationChar && req.generationChar.length === 1) { must.push(req.generationChar); }
    must.forEach(function (ch) {
      var cid = kb.charByChar[ch];
      if (cid && pool.indexOf(cid) < 0) { pool.unshift(cid); }
    });

    // 硬约束过滤
    var out = [], rejectStat = {};
    function bump(k) { rejectStat[k] = (rejectStat[k] || 0) + 1; }
    for (var pi = 0; pi < pool.length; pi++) {
      var cid2 = pool[pi];
      var h2 = kb.hanzi[cid2];
      var isMust = !!mustSet[h2.char];
      if (req.avoidChars[h2.char]) { bump('用户避用字'); continue; }
      if (h2.char === req.surname) { bump('与姓同字'); continue; }
      if (!isMust && !req.allowRare && h2.rare_code === '高') { bump('生僻度=高'); continue; }
      if (!isMust && h2.negative_risk_code === '高') { bump('负面联想=高'); continue; }
      if (!isMust && (req.gender === '男' || req.gender === '偏男性')
          && h2.gender_bias === '偏女性') { bump('性别倾向不符'); continue; }
      if (!isMust && (req.gender === '女' || req.gender === '偏女性')
          && h2.gender_bias === '偏男性') { bump('性别倾向不符'); continue; }
      out.push(cid2);
    }

    function factStrength(cid) {
      var m = kb.charFact[cid] || {};
      var best = 0.0, any = false;
      for (var k in m) {
        if (!Object.prototype.hasOwnProperty.call(m, k)) { continue; }
        if (factIdSet[k]) {
          any = true;
          var w = FACT_W[m[k]]; if (w === undefined) { w = 0.4; }
          if (w > best) { best = w; }
        }
      }
      return any ? best : 0.0;
    }

    var rankCache = {};
    var ctx = {
      AFF: AFF, mustSet: mustSet, avoidCues: avoidCues, cueSpecs: cueSpecs,
      profCues: profCues, factStrength: factStrength
    };
    function rank(cid) {
      var c = rankCache[cid];
      if (c !== undefined) { return c; }
      var r = rankOf(kb, req, cid, ctx);
      rankCache[cid] = r;
      return r;
    }

    // 排序：Python 是 out.sort(key=rank)，即"按 rank 的返回值排序"。
    // 注意不能写成 out.sort(cmpRank)——out 里存的是 cid 字符串，
    // 比较器收到的是字符串而不是 rank 元组（这个错误当时让 13 个场景全挂，
    // 且因为元组本身是对的，只看最终顺序很难看出问题）。这里用
    // 装饰-排序-还原，与 Python 的 key= 语义完全一致。
    var keyed = out.map(function (cid) { return [rank(cid), cid]; });
    keyed.sort(function (x, y) { return cmpRank(x[0], y[0]); });
    out = keyed.map(function (p) { return p[1]; });

    var rng = PRNG.create((req.seed ^ 0x5EED) >>> 0);
    var mustFirst = [], rest = [];
    out.forEach(function (cid) {
      if (mustSet[kb.hanzi[cid].char]) { mustFirst.push(cid); } else { rest.push(cid); }
    });
    var groups = [], cur = [], curKey = null;
    for (var ri = 0; ri < rest.length; ri++) {
      var cid3 = rest[ri];
      var k5 = rank(cid3).slice(0, 5).join(',');
      if (curKey === null || k5 === curKey) { cur.push(cid3); curKey = k5; }
      else { groups.push(cur); cur = [cid3]; curKey = k5; }
    }
    if (cur.length) { groups.push(cur); }
    var sampled = [];
    if (opts.noShuffle) {
      // 诊断用：只做排序与分组，不打散。用于把"排序不同"与"打散不同"分开定位
      // （Python 侧用 monkey-patch 把 shuffle 变成空操作，得到同一视角）。
      groups.forEach(function (g) { sampled = sampled.concat(g); });
    } else {
      groups.forEach(function (g) { rng.shuffle(g); sampled = sampled.concat(g); });
    }
    return { pool: mustFirst.concat(sampled).slice(0, poolLimit), rejectStat: rejectStat };
  }

  return {
    selectChars: selectChars,
    rankOf: rankOf,
    makeRankCtx: makeRankCtx,
    matchFacts: matchFacts,
    charBorrowScore: charBorrowScore,
    charBorrowHit: charBorrowHit,
    charGenderScore: charGenderScore,
    BORROW_FAMILY: BORROW_FAMILY,
    FACT_W: FACT_W
  };
});
