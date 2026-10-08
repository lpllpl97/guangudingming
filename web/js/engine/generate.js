/* 主流程 —— engine.py:526-589（原则匹配）+ 593-629（需求解析）+ 1444-1802（generate）的移植。
 *
 * 这是最后一块：把前面所有切片串成一条完整流水线，产出与 Python 完全相同的 result 字典。
 *
 * 一处**刻意的顺序选择**：Python 的 must_ids 来自 set，遍历顺序受 PYTHONHASHSEED 影响，
 * JS 无法也不该复现哈希顺序。我先用 tools/check_reproducibility.py 在 5 种哈希种子下
 * 验过"整个结果字典逐字节一致"，确认最终结果不依赖该顺序，因此这里用**确定性的顺序**
 * （fixed_chars 原序，再 generation_char），并在对拍中验证两种顺序给出同一结果。
 *
 * 用法：const { generate } = require('./web/js/engine/generate.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMGenerate = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function dep(name) {
    if (typeof module === 'object' && module.exports) { return require('./' + name + '.js'); }
    return root[{ prng: 'GDMRandom', affinity: 'GDMAffinity', select: 'GDMSelect',
      score: 'GDMScore', risks: 'GDMRisks', explain: 'GDMExplain',
      request: 'GDMRequest', textmatch: 'GDMText' }[name]];
  }
  var PRNG = dep('prng');
  var AFF = dep('affinity');
  var SEL = dep('select');
  var SCORE = dep('score');
  var RISKS = dep('risks');
  var EXP = dep('explain');
  var REQ = dep('request');
  var TX = dep('textmatch');

  /* 原则匹配：只在《左传》五类里匹配适用项。返回 {hits, mode}。 */
  function matchPrinciples(kb, req) {
    var hits = [];
    var matchedFacts = SEL.matchFacts(kb, req.birthFacts);
    var requested = (req.principles || []).filter(function (p) {
      return Object.prototype.hasOwnProperty.call(kb.principles, p);
    });
    var tagGroups = {}, tagNames = {};
    (req.goalTags || []).forEach(function (t) {
      if (kb.tags[t]) {
        tagGroups[kb.tags[t].group_code] = true;
        tagNames[kb.tags[t].user_phrase] = true;
      }
    });
    var names = Object.keys(tagNames);

    if (requested.length) {
      requested.forEach(function (pid) {
        hits.push([pid, '用户指定：' + kb.principles[pid].rule_meaning, '用户显式指定五类原则']);
      });
      return { hits: hits, mode: '用户指定' };
    }

    // F01 信：有可核验事实就必须启用
    if (req.birthFacts) {
      if (matchedFacts.length) {
        var fy = matchedFacts.map(function (f) {
          return f[1] + '（' + f[2] + '，命中“' + f[3] + '”）';
        }).join('、');
        hits.push(['F01', '用户提供可核验事实：' + req.birthFacts + '；已识别为 ' + fy,
          '出生时令/纪念事件']);
      } else {
        hits.push(['F01', '用户提供可核验事实：' + req.birthFacts, '出生时令/纪念事件']);
      }
    }
    // F05 类：家族传承
    var inheritKw = ['家族', '字辈', '传承', '辈分', '宗族'];
    var inheritSignal = names.some(function (n) {
      return inheritKw.some(function (k) { return String(n || '').indexOf(k) >= 0; });
    }) || (String(req.rawInput || '').indexOf('家庭') >= 0
      && String(req.rawInput || '').indexOf('传承') >= 0);
    if (req.generationChar) {
      hits.push(['F05', '用户提供字辈/家族传承字：' + req.generationChar, '家族辈分要求']);
    } else if (inheritSignal) {
      hits.push(['F05', '用户需求标签指向家族传承', '家族传承意愿']);
    }
    // F04 假：明确要求借物
    var borrowKw = ['借物', '器物', '借玉', '玉的', '佩玉', '礼器', '以物', '假于物'];
    var borrowSignal = names.some(function (n) {
      return borrowKw.some(function (k) {
        return String(n || '').indexOf(k) >= 0 || String(req.rawInput || '').indexOf(k) >= 0;
      });
    });
    if (borrowSignal) { hits.push(['F04', '用户需求指向借外物取义', '借物命名意愿']); }
    // F02 义：德性/品格/志向
    var virtueWords = ['品格', '德行', '德性', '仁', '义', '智', '诚', '信', '志向', '抱负',
      '成长', '修身', '坚韧', '温润', '聪慧', '好学', '担当', '自律', '价值',
      '愿望', '气质', '内涵', '格局', '胸怀', '大气', '端方', '守礼'];
    var f02 = !!tagGroups['G3'] || names.some(function (n) {
      return virtueWords.some(function (w) { return String(n || '').indexOf(w) >= 0; });
    });
    if (f02) { hits.push(['F02', '用户需求指向德行与品格方向', '德性/品格/志向目标']); }
    // F03 象：意象/风格
    var raw = String(req.rawInput || '');
    var f03kw = ['意象', '诗', '自然', '山水', '花木', '植物', '清雅', '飘', '意境'];
    var f03 = !!tagGroups['G4'] || (req.styles || []).length > 0
      || f03kw.some(function (k) { return raw.indexOf(k) >= 0; });
    if (f03) { hits.push(['F03', '用户需求指向自然物象与文化意象', '意象/风格偏好']); }

    if (!hits.length) {
      return { hits: [['F02', '系统推荐：以德行品格为主线', '系统默认'],
        ['F03', '系统推荐：以自然意象为辅线', '系统默认']], mode: '系统推荐' };
    }
    var order = { 'F01': 0, 'F05': 1, 'F04': 2, 'F02': 3, 'F03': 4 };
    hits.sort(function (a, b) {
      var oa = order[a[0]] === undefined ? 9 : order[a[0]];
      var ob = order[b[0]] === undefined ? 9 : order[b[0]];
      return oa - ob;
    });
    hits = hits.slice(0, 3);
    var allBasis = hits.every(function (h) {
      return h[0] === 'F01' || h[0] === 'F05' || h[0] === 'F04';
    });
    if (allBasis) { hits.push(['F02', '补主线：以德行品格为语义主线', '主线补足']); }
    var usable = hits.filter(function (h) { return kb.principleChars[h[0]]; });
    return { hits: usable.length ? usable : hits, mode: '需求推导' };
  }

  /* 需求解析：自由文本 → 需求标签。 */
  function parseGoals(kb, text, opts) {
    opts = opts || {};
    var groups = opts.groups || null;
    var t = ((text || '') + '；' + (opts.extraText || '')).trim();
    if (!t) { return []; }
    var scored = [];
    Object.keys(kb.tags).forEach(function (tid) {
      var tag = kb.tags[tid];
      if (groups && groups.indexOf(tag.group_code || '') < 0) { return; }
      var score = 0;
      var phrase = String(tag.user_phrase || '').trim();
      if (phrase && t.indexOf(phrase) >= 0) { score += 5; }
      ['semantic_map', 'imagery_hint'].forEach(function (field) {
        var v = String(tag[field] || '').trim();
        if (!v || v === '不适用' || v === '—') { return; }
        v.split(/[、,，/／;；\s]+/).forEach(function (tok) {
          var s2 = tok.trim();
          if (s2.length >= 2 && t.indexOf(s2) >= 0) { score += 2; }
          else if (s2.length === 1 && t.indexOf(s2) >= 0) { score += 1; }
        });
      });
      phrase.split(/[、,，/／;；\s]+/).forEach(function (tok) {
        if (tok.length >= 2 && t.indexOf(tok) >= 0) { score += 3; }
      });
      if (score) { scored.push([score, tid]); }
    });
    // Python: scored.sort(reverse=True) —— (score, tid) 整元组降序，同分时 tid 也降序
    scored.sort(function (a, b) {
      if (b[0] !== a[0]) { return b[0] - a[0]; }
      return a[1] < b[1] ? 1 : (a[1] > b[1] ? -1 : 0);
    });
    return scored.slice(0, 5).map(function (x) { return x[1]; });
  }

  function sortedUniq(arr) {
    var out = arr.slice().sort();
    return out.filter(function (x, i) { return i === 0 || x !== out[i - 1]; });
  }

  function generate(kb, req, returnRejected) {
    var t0 = Date.now();
    var ENGINE_VERSION = kb.meta.engine_version || 'naming-engine-0.3.0';

    // 命名依据最多同时选 2 项
    var pickedP = sortedUniq(req.principles || []);
    if (pickedP.length > 2) {
      var names = pickedP.map(function (p) {
        return (kb.principles[p] || {}).name || p;
      }).join('、');
      return { ok: false,
        error: '命名依据最多同时选 2 项，当前选了 ' + pickedP.length + ' 项（' + names + '）。'
          + '两个字承载不了太多意义，请保留最贴近的 2 项。',
        notices: [], principle_hits: [], rejects: {} };
    }
    var goalTags = (req.goalTags || []).slice();
    var parsed = parseGoals(kb, req.rawInput);
    parsed = parsed.concat(parseGoals(kb, req.imageryHint, { groups: ['G4', 'G4S'] }));
    parsed.forEach(function (t) { if (goalTags.indexOf(t) < 0) { goalTags.push(t); } });

    var mp = matchPrinciples(kb, req);
    var principleHits = mp.hits, mode = mp.mode;
    var factHits = principleHits.some(function (p) { return p[0] === 'F01'; })
      ? SEL.matchFacts(kb, req.birthFacts) : [];
    var factIdSet = {};
    factHits.forEach(function (f) { factIdSet[f[0]] = true; });
    var ga = AFF.goalAffinity(kb, goalTags);
    var avoidCues = ga.avoid;
    var profCues = ga.profile;
    var g3Labels = goalTags.filter(function (t) {
      return kb.tags[t] && kb.tags[t].group_code === 'G3' && kb.tags[t].user_phrase;
    }).map(function (t) { return kb.tags[t].user_phrase; });
    var cueSpecs = AFF.imagerySpecs(kb, req.imageryHint);
    var cueOpts = AFF.resolveImageryOptions(kb, req.imageryHint);
    var cueStrict = false;
    var nCue = 0;

    var notices = [];
    (req.fixedChars || []).concat(String(req.generationChar || '').split('')).forEach(function (ch) {
      if (ch && !kb.charByChar[ch]) {
        notices.push('“' + ch + '”不在字库中，无法作为保留字/字辈字使用');
      }
    });
    (req.fixedDropped || []).forEach(function (ch) {
      notices.push('“' + ch + '”不是汉字，已从“必须保留的字”中忽略');
    });
    (req.avoidDropped || []).forEach(function (ch) {
      notices.push('“' + ch + '”不是汉字，已从“避用的字”中忽略');
    });

    var mustChars = {};
    (req.fixedChars || []).forEach(function (c) { mustChars[c] = true; });
    String(req.generationChar || '').split('').forEach(function (c) { if (c) { mustChars[c] = true; } });
    var mustOk = {};
    Object.keys(mustChars).forEach(function (c) { if (kb.charByChar[c]) { mustOk[c] = true; } });

    // 单字名 + 保留字：答案唯一
    if (req.givenLen === 1 && Object.keys(mustChars).length) {
      var known = Object.keys(mustChars).filter(function (c) { return kb.charByChar[c]; });
      var unknown = Object.keys(mustChars).filter(function (c) { return !kb.charByChar[c]; });
      if (Object.keys(mustChars).length > 1) {
        return { ok: false,
          error: '单字名只能指定一个保留字/字辈字，当前指定了 '
            + Object.keys(mustChars).length + ' 个（' + Object.keys(mustChars).sort().join('、') + '）',
          notices: unknown.map(function (c) { return '“' + c + '”不在字库中'; }),
          principle_hits: principleHits, rejects: {} };
      }
      if (unknown.length) {
        return { ok: false,
          error: '指定的字“' + unknown[0] + '”不在字库中，无法作为保留字使用',
          notices: ['请换一个字，或在“避开/允许生僻字”里调整约束'],
          principle_hits: principleHits, rejects: {} };
      }
      var ch0 = known.sort()[0];
      var char = kb.hanzi[kb.charByChar[ch0]];
      var given0 = ch0;
      var rk0 = RISKS.checkRisks(kb, req, given0, [char]);
      if (rk0.blocked) {
        return { ok: false,
          error: '指定的字“' + ch0 + '”触发硬拦截：' + rk0.rejects.join('；'),
          principle_hits: principleHits, rejects: {} };
      }
      var sc0 = SCORE.scoreCandidate(kb, req, given0, [char], principleHits, goalTags, factIdSet);
      var it0 = { id: null, given_name: given0, full_name: req.surname + given0,
        score: sc0.score, score_detail: sc0.detail, chars: [char],
        principles: principleHits.map(function (p) {
          return [p[0], kb.principles[p[0]].name, p[1]]; }),
        warns: rk0.warns, rules_hit: rk0.rules, notes: sc0.notes, explanation: '' };
      it0.explanation = EXP.buildExplanation(kb, req, given0, [char], principleHits, null,
        sc0.detail, rk0.warns, factHits, null, notices);
      var sem0 = {};
      EXP.evidenceChain(kb, char.char_id).forEach(function (c) { sem0[c.semantic_id] = true; });
      it0.semantics = Object.keys(sem0).sort();
      return { ok: true, request: REQ.toDict(req), mode: mode, goal_tags: goalTags,
        principle_hits: principleHits.map(function (p) {
          return { id: p[0], name: kb.principles[p[0]].name,
            meaning: kb.principles[p[0]].rule_meaning, basis: p[1], trigger: p[2] }; }),
        facts_matched: factHits.map(function (f) {
          return { id: f[0], label: f[1], kind: f[2], keyword: f[3],
            chars: f[4].map(function (c) { return kb.hanzi[c].char; }) }; }),
        pool_size: 1, reject_stat: {},
        notices: ['单字名已指定保留字，答案唯一，无需生成候选'].concat(notices),
        candidates: [it0], rejected_count: 0, latency_ms: Date.now() - t0,
        engine_version: ENGINE_VERSION,
        knowledge_version: kb.meta.knowledge_version };
    }

    var sel = SEL.selectChars(kb, req, principleHits, {
      avoidCues: avoidCues, cueSpecs: cueSpecs, profCues: profCues
    });
    var pool = sel.pool, rejectStat = sel.rejectStat;
    if (!pool.length) {
      return { ok: false,
        error: '在当前原则与约束下没有可用字，请放宽生僻度或避用字限制',
        notices: notices, principle_hits: principleHits, rejects: rejectStat };
    }
    var poolChars = {};
    pool.forEach(function (c) { poolChars[kb.hanzi[c].char] = true; });
    (req.fixedChars || []).concat(String(req.generationChar || '').split('')).forEach(function (ch) {
      if (ch && kb.charByChar[ch] && !poolChars[ch]) {
        notices.push('“' + ch + '”被避用字或生僻度等约束排除，未能进入候选');
      }
    });

    // ---- 组合生成 ----
    var rng = PRNG.create(req.seed);
    var mustSet = {};
    (req.fixedChars || []).forEach(function (c) { if (c) { mustSet[c] = true; } });
    String(req.generationChar || '').split('').forEach(function (c) { if (c) { mustSet[c] = true; } });
    // 确定性顺序（Python 侧来自 set 的哈希序，经验证不影响最终结果，见文件头说明）
    var mustIds = Object.keys(mustSet).filter(function (c) { return kb.charByChar[c]; })
      .map(function (c) { return kb.charByChar[c]; });
    var borrowIds = pool.filter(function (cid) {
      return SEL.charBorrowScore(kb.hanzi[cid], req.borrowWords) > 0;
    });
    var front = [];
    mustIds.concat(borrowIds).forEach(function (cid) {
      if (front.indexOf(cid) < 0) { front.push(cid); }
    });
    var rest = pool.filter(function (cid) { return front.indexOf(cid) < 0; });

    var combos = [];
    if (req.givenLen === 1) {
      var src = mustIds.length ? mustIds : pool.slice(0, 24);
      combos = src.map(function (c) { return [c]; });
    } else {
      var fr = front.concat(rest);
      front.forEach(function (m) {
        fr.slice(0, 40).forEach(function (cid) {
          if (cid !== m) { combos.push([m, cid]); }
        });
      });
      var head = fr.slice(0, 26), tail = fr.slice(0, 40);
      head.forEach(function (a) {
        tail.forEach(function (b) {
          if (a !== b) { combos.push([a, b]); }
        });
      });
      var keyed = combos.map(function (cmb) {
        // Python: priority = 0 if any(g in cmb for g in front) else 1
        // front 为空时全部为 1（我第一版写成循环里赋 1，front 为空则留在 0，是错的）
        var inFront = cmb.some(function (c) { return front.indexOf(c) >= 0; });
        return [inFront ? 0 : 1, rng.random(), cmb];
      });
      keyed.sort(function (x, y) {
        if (x[0] !== y[0]) { return x[0] - y[0]; }
        return x[1] - y[1];
      });
      combos = keyed.map(function (x) { return x[2]; });
    }
    combos = combos.slice(0, 600);

    var scored = [], rejected = [];
    combos.forEach(function (combo) {
      var chars = combo.map(function (c) { return kb.hanzi[c]; });
      var given = chars.map(function (h) { return h.char; }).join('');
      // 两个字相同则跳过
      var uniq = {};
      for (var qi = 0; qi < given.length; qi++) { uniq[given[qi]] = true; }
      if (Object.keys(uniq).length < given.length) { return; }
      var hp = RISKS.homophoneHits(kb, req, given);
      var rk = RISKS.checkRisks(kb, req, given, chars, hp);
      var sc = SCORE.scoreCandidate(kb, req, given, chars, principleHits, goalTags, factIdSet);
      var final = Math.max(0.0, Math.min(100.0, sc.score + rk.penalty * 0.1));
      var item = {
        given_name: given, full_name: req.surname + given, score: final,
        score_detail: sc.detail, chars: chars,
        principles: principleHits.map(function (p) {
          return [p[0], kb.principles[p[0]].name, p[1]]; }),
        warns: rk.warns, rules_hit: rk.rules, notes: sc.notes, homophone: hp
      };
      if (rk.blocked) { item.reject_reason = rk.rejects; rejected.push(item); }
      else { scored.push(item); }
    });

    // ---- 硬约束过滤 ----
    var mustCharList = Object.keys(mustChars);
    var mustOkList = Object.keys(mustOk);
    function hasAll(it, chars) {
      var set = {};
      it.chars.forEach(function (h) { set[h.char] = true; });
      return chars.every(function (c) { return set[c]; });
    }
    if (req.givenLen >= 2) {
      if (mustOkList.length) {
        var conform = scored.filter(function (it) { return hasAll(it, mustOkList); });
        if (!conform.length) {
          return { ok: false,
            error: '无法满足必用字/字辈字（' + mustOkList.slice().sort().join('、')
              + '）：当前条件下没有候选能包含它，请放宽其他条件或换一个字',
            notices: notices, principle_hits: principleHits, rejects: {} };
        }
        scored = conform;
      } else if (mustCharList.length) {
        return { ok: false,
          error: '指定的字（' + mustCharList.slice().sort().join('、')
            + '）都不在字库中，无法作为保留字/字辈字使用',
          notices: notices, principle_hits: principleHits, rejects: {} };
      }
      if (req.borrowWords && req.borrowWords.length) {
        var bconform = scored.filter(function (it) {
          return it.chars.some(function (h) {
            return SEL.charBorrowScore(h, req.borrowWords) > 0; });
        });
        if (bconform.length) { scored = bconform; }
      }
      if (Object.keys(factIdSet).length) {
        var fconform = scored.filter(function (it) {
          return it.chars.some(function (h) {
            var m = kb.charFact[h.char_id] || {};
            return Object.keys(m).some(function (k) { return factIdSet[k]; });
          });
        });
        if (fconform.length) { scored = fconform; }
      }
    }
    // 性别倾向
    if (req.gender === '男' || req.gender === '偏男性' || req.gender === '女'
        || req.gender === '偏女性') {
      var want = (req.gender === '女' || req.gender === '偏女性') ? '偏女性' : '偏男性';
      var nWant = 0;
      kb.hanziRows.forEach(function (h) { if (h.gender_bias === want) { nWant++; } });
      var need = nWant >= 6 ? 2 : 1;
      var gconform = scored.filter(function (it) {
        return it.chars.some(function (h) { return h.gender_bias === want; }); });
      if (gconform.length >= need) { scored = gconform; }
      else {
        var gconform2 = scored.filter(function (it) {
          return !it.chars.some(function (h) {
            return h.gender_bias && h.gender_bias !== want && h.gender_bias !== '中性'; });
        });
        if (gconform2.length >= need) { scored = gconform2; }
      }
    }
    // 意象契合
    if (cueSpecs.length) {
      nCue = AFF.cuePoolSize(kb, cueSpecs, pool);
      var anyc = scored.filter(function (it) {
        return it.chars.some(function (h) { return AFF.imageryAffinity(h, cueSpecs) > 0; }); });
      var both = scored.filter(function (it) {
        return it.chars.every(function (h) { return AFF.imageryAffinity(h, cueSpecs) > 0; }); });
      var minN = Math.min(3, req.topN);
      if (!mustCharList.length && nCue >= 6 && both.length >= minN) {
        scored = both; cueStrict = true;
        notices.push('已按意象「' + cueOpts.join('、') + '」选字：两个字都取自该意象字族（可用 '
          + nCue + ' 个字）');
      } else if (anyc.length >= minN) {
        scored = anyc;
        notices.push('已按意象「' + cueOpts.join('、') + '」优先选字：每个名字至少一个字取自该意象字族（可用 '
          + nCue + ' 个字）');
      } else {
        notices.push('意象「' + cueOpts.join('、') + '」在字库里可用字较少（' + nCue
          + ' 个），已尽量贴近；若想更贴切，可放宽「避开用字」或换一个意象');
      }
    }
    // 谐音联想：读起来像常用词的在还有别的选择时不用
    if (scored.length && scored.some(function (it) { return it.homophone && it.homophone.length; })) {
      var clean = scored.filter(function (it) { return !(it.homophone && it.homophone.length); });
      if (clean.length >= Math.min(3, req.topN)) {
        scored = clean;
        notices.push('已避开读起来像常用词的组合（如「招待」这类谐音）');
      }
    }
    // 表达目标
    if (profCues.length && g3Labels.length) {
      var pconform = scored.filter(function (it) {
        return it.chars.some(function (h) { return AFF.charProfileHit(h, profCues); }); });
      if (pconform.length >= Math.min(3, req.topN)) {
        scored = pconform;
        notices.push('已按表达目标「' + g3Labels.join('、') + '」选字：每个名字至少一个字贴合该目标');
      }
    }

    scored.sort(function (a, b) {
      var am = a.chars.some(function (h) { return mustChars[h.char]; }) ? 1 : 0;
      var bm = b.chars.some(function (h) { return mustChars[h.char]; }) ? 1 : 0;
      if (bm !== am) { return bm - am; }
      return b.score - a.score;
    });

    // ---- 多样性选择 ----
    var div = Math.max(0.0, Math.min(1.0,
      req.diversity === undefined || req.diversity === null ? 0.6 : req.diversity));
    function novelty(it, used) {
      var chs = it.chars.map(function (h) { return h.char; });
      var n = 0;
      chs.forEach(function (c) { if (!used[c]) { n++; } });
      return n / chs.length;
    }
    var picked = [], seenNames = {}, used = {};
    var seenPairs = {};
    var remaining = scored.slice();
    var cap = pool.length >= 3 * req.topN ? 1 : 2;
    if (pool.length < 2 * req.topN) { cap = 3; }
    if (cueStrict && nCue && nCue < 3 * req.topN) { cap = Math.max(cap, 2); }
    var noticePool = null;
    while (remaining.length && picked.length < req.topN) {
      var bestI = null, bestKey = null;
      for (var i = 0; i < remaining.length; i++) {
        var it = remaining[i];
        if (seenNames[it.given_name]) { continue; }
        var chs = it.chars.map(function (h) { return h.char; });
        var overCap = chs.some(function (c) {
          return (used[c] || 0) >= cap && !mustChars[c]; });
        if (overCap) { continue; }
        if (chs.length === 2 && chs[0] !== chs[1]) {
          var pk = chs.slice().sort().join('');
          if (seenPairs[pk]) { continue; }
        }
        var key = it.score * (1.0 - div) + 100.0 * novelty(it, used) * div;
        if (bestKey === null || key > bestKey) { bestKey = key; bestI = i; }
      }
      if (bestI === null) { break; }
      var chosen = remaining.splice(bestI, 1)[0];
      seenNames[chosen.given_name] = true;
      if (chosen.chars.length === 2 && chosen.chars[0].char !== chosen.chars[1].char) {
        seenPairs[chosen.chars.map(function (h) { return h.char; }).sort().join('')] = true;
      }
      picked.push(chosen);
      chosen.chars.forEach(function (h) { used[h.char] = (used[h.char] || 0) + 1; });
    }
    if (picked.length < req.topN) {
      if (pool.length < 2 * req.topN) {
        noticePool = '可用字较少（' + pool.length + ' 字），候选之间难免出现重复用字';
      }
      var byScore = remaining.slice().sort(function (a, b) { return b.score - a.score; });
      for (var fi = 0; fi < byScore.length; fi++) {
        var it2 = byScore[fi];
        if (seenNames[it2.given_name]) { continue; }
        seenNames[it2.given_name] = true;
        picked.push(it2);
        if (picked.length >= req.topN) { break; }
      }
    }
    if (noticePool) { notices.push(noticePool); }

    picked.forEach(function (it) {
      it.explanation = EXP.buildExplanation(kb, req, it.given_name, it.chars, principleHits,
        null, it.score_detail, it.warns, factHits, null, notices);
      var sem = {};
      it.chars.forEach(function (h) {
        EXP.evidenceChain(kb, h.char_id).forEach(function (c) { sem[c.semantic_id] = true; });
      });
      it.semantics = Object.keys(sem).sort();
    });

    var result = {
      ok: true,
      request: REQ.toDict(req),
      mode: mode,
      goal_tags: goalTags,
      principle_hits: principleHits.map(function (p) {
        return { id: p[0], name: kb.principles[p[0]].name,
          meaning: kb.principles[p[0]].rule_meaning, basis: p[1], trigger: p[2] }; }),
      facts_matched: factHits.map(function (f) {
        return { id: f[0], label: f[1], kind: f[2], keyword: f[3],
          chars: f[4].map(function (c) { return kb.hanzi[c].char; }) }; }),
      pool_size: pool.length,
      reject_stat: rejectStat,
      notices: notices,
      candidates: picked,
      rejected_count: rejected.length,
      latency_ms: Date.now() - t0,
      engine_version: ENGINE_VERSION,
      knowledge_version: kb.meta.knowledge_version,
      kb_version: kb.meta.kb_version
    };
    if (returnRejected) { result.rejected = rejected.slice(0, 10); }
    return result;
  }

  return { generate: generate, parseGoals: parseGoals, matchPrinciples: matchPrinciples };
});
