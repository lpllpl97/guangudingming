/* 亲和力原语 —— engine.py:633-698 + 379-424 的 JavaScript 移植。
 *
 * 这几支函数决定"用户选了目标/意象之后，哪些字算贴切"，是选字排序的直接输入：
 *   resolve_imagery_options / imagery_specs   把用户填的意象文本映射到线索
 *   imagery_affinity                          单字对意象的契合度（0 / 0.8 / 1.0）
 *   cue_pool_size                             该意象在字库里有多少可用字
 *   goal_affinity                             汇总所选目标的 profile / avoid 线索
 *   char_profile_hit / char_conflicts          单字是否命中 / 冲突
 *
 * 两处特意照抄的细节（都是实际踩过的坑）：
 *   1) 单字关键词只在 culture_imagery（受控词表）里匹配，不去匹配 persona_semantic /
 *      modern_meaning 的自由文本——否则「家风」「威仪」会因为含「风」被误判成风霜意象。
 *   2) affinity 是 defaultdict：查不到 tag 时返回 {profile:[], avoid:[]} 而不是 None；
 *      但 goal_affinity 用的是 .get()，查不到要当"没有线索"跳过。
 *
 * 用法：
 *   浏览器：<script src="js/engine/affinity.js"></script> → window.GDMAffinity
 *   Node  ：const A = require('./web/js/engine/affinity.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMAffinity = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 把用户填的意象文本映射到 imagery_cue 的选项名（选项名出现在文本里即算选中，可多选）。 */
  function resolveImageryOptions(kb, hint) {
    var text = String(hint || '').trim();
    if (!text) { return []; }
    var out = [];
    for (var i = 0; i < kb.imageryCueOptions.length; i++) {
      var opt = kb.imageryCueOptions[i];
      if (opt && text.indexOf(opt) >= 0) { out.push(opt); }
    }
    return out;
  }

  /* 所选意象对应的子族规格列表。 */
  function imagerySpecs(kb, hint) {
    var out = [];
    var opts = resolveImageryOptions(kb, hint);
    for (var i = 0; i < opts.length; i++) {
      var specs = kb.imageryCues[opts[i]] || [];
      for (var j = 0; j < specs.length; j++) { out.push(specs[j]); }
    }
    return out;
  }

  /* 单字对所选意象的契合度 0~1：
     明确字表命中 → 1.0；关键词命中 → min(1.0, 0.6 + 0.2*hits)。 */
  function imageryAffinity(h, specs) {
    if (!specs || !specs.length) { return 0.0; }
    var ch = h.char;
    var imagery = String(h.culture_imagery || '');
    // 对应 Python 的 ' '.join(str(h.get(k) or '') for k in ('persona_semantic','modern_meaning'))
    var prose = String(h.persona_semantic || '') + ' ' + String(h.modern_meaning || '');
    var best = 0.0;
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      if (spec.chars[ch]) { return 1.0; }
      var hits = 0;
      var kws = spec.keywords;
      for (var j = 0; j < kws.length; j++) {
        var k = kws[j];
        if (!k) { continue; }
        if (k.length === 1) {
          if (imagery.indexOf(k) >= 0) { hits += 1; }
        } else {
          if (imagery.indexOf(k) >= 0 || prose.indexOf(k) >= 0) { hits += 1; }
        }
      }
      if (hits) {
        var v = Math.min(1.0, 0.6 + 0.2 * hits);
        if (v > best) { best = v; }
      }
    }
    return best;
  }

  /* 所选意象在字库里可用的字数。charIds 省略时用全部字。 */
  function cuePoolSize(kb, specs, charIds) {
    if (!specs || !specs.length) { return 0; }
    var ids = charIds || Object.keys(kb.hanzi);
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      if (imageryAffinity(kb.hanzi[ids[i]], specs) > 0) { n++; }
    }
    return n;
  }

  /* 汇总所选目标标签的亲和力线索：返回 {profile: [...], avoid: [...], labels: [...]} */
  function goalAffinity(kb, goalTags) {
    var profSet = {}, avoidSet = {}, prof = [], avoid = [], labels = [];
    var tags = goalTags || [];
    for (var i = 0; i < tags.length; i++) {
      var a = kb.affinity[tags[i]] || null;
      if (!a) { continue; }
      (a.profile || []).forEach(function (c) { if (!profSet[c]) { profSet[c] = 1; prof.push(c); } });
      (a.avoid || []).forEach(function (c) { if (!avoidSet[c]) { avoidSet[c] = 1; avoid.push(c); } });
      var tag = kb.tags[tags[i]] || {};
      if (tag.user_phrase) { labels.push(tag.user_phrase); }
    }
    return { profile: prof, avoid: avoid, labels: labels };
  }

  /* 该字是否命中用户所选表达目标的贴切线索（正向关联）。 */
  function charProfileHit(h, profileCues) {
    if (!profileCues || !profileCues.length) { return false; }
    var own = String(h.persona_semantic || '') + '、' + String(h.culture_imagery || '')
      + '、' + String(h.modern_meaning || '');
    for (var i = 0; i < profileCues.length; i++) {
      var cue = profileCues[i];
      if (cue && own.indexOf(cue) >= 0) { return true; }
    }
    return false;
  }

  /* 该字是否与用户所选目标明显冲突；返回命中的线索（无冲突返回 null）。 */
  function charConflicts(h, avoidCues) {
    if (!avoidCues || !avoidCues.length) { return null; }
    var own = String(h.persona_semantic || '') + '、' + String(h.culture_imagery || '')
      + '、' + String(h.modern_meaning || '');
    for (var i = 0; i < avoidCues.length; i++) {
      var cue = avoidCues[i];
      if (cue && own.indexOf(cue) >= 0) { return cue; }
    }
    return null;
  }

  return {
    resolveImageryOptions: resolveImageryOptions,
    imagerySpecs: imagerySpecs,
    imageryAffinity: imageryAffinity,
    cuePoolSize: cuePoolSize,
    goalAffinity: goalAffinity,
    charProfileHit: charProfileHit,
    charConflicts: charConflicts
  };
});
