/* 文本匹配与需求匹配度（S02）—— engine.py:1043-1135 的 JavaScript 移植。
 *
 * 三块：_tokens / _token_overlap / _demand_match。
 * 这里刻意与 Python 保持同样的运算顺序与四舍五入时机，因为对拍要求逐位一致；
 * 缓存（_TOKEN_CACHE / _DEMAND_CACHE）在 Python 里只是性能优化、不改结果，
 * 所以 JS 这边**不做缓存**——少一层状态，少一类"缓存让两次结果不同"的隐患。
 *
 * 用法：
 *   浏览器：<script src="js/engine/textmatch.js"></script> → window.GDMText
 *   Node  ：const T = require('./web/js/engine/textmatch.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMText = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 与 Python 的 re.split(r'[、,，/／;；\s]+') 等价：
     分隔符是 、 , ， / ／ ; ； 以及任意空白；丢弃空串与无意义占位。 */
  function tokens(text) {
    if (!text) { return []; }
    var parts = String(text).split(/[、,，/／;；\s]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var x = parts[i];
      if (x && x !== '不适用' && x !== '—' && x !== '-') { out.push(x); }
    }
    return out;
  }

  /* 标签侧的词与候选字侧的描述双向包含匹配，返回 0~1。 */
  function tokenOverlap(text, target) {
    if (!text || !target) { return 0.0; }
    var toks = tokens(text);
    if (!toks.length) { return 0.0; }
    var hit = 0.0;
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (target.indexOf(t) >= 0) { hit += 1.0; continue; }
      for (var j = 0; j < t.length; j++) {
        if (target.indexOf(t[j]) >= 0) { hit += 0.6; break; }
      }
    }
    return Math.min(1.0, hit / toks.length);
  }

  /* 单字的匹配分（Python 里是 _demand_match 内部的 match_one）。 */
  function matchOne(kb, h, tagText, tagImagery, tagSem, tagClassic) {
    var own = [h.persona_semantic, h.culture_imagery, h.modern_meaning]
      .filter(function (x) { return !!x; }).join('、');
    var semList = kb.charSemantics[h.char_id] || [];
    var names = [];
    for (var i = 0; i < semList.length; i++) {
      var s = kb.semantic[semList[i].semantic_id];
      if (s && s.name) { names.push(s.name); }
    }
    var own2 = own + '、' + names.join('、');

    var cands = [
      tokenOverlap(tagText, own2),
      tokenOverlap(tagImagery, own2),
      tokenOverlap(tagSem, own2),
      tokenOverlap(tagText, own),
      tokenOverlap(tagSem, own)
    ];
    if (tagClassic) {
      // 用标签的优先典籍与候选字出处做匹配
      var ownCls = '';
      for (var k = 0; k < semList.length; k++) {
        var it = semList[k];
        if (it.text_id) {
          var t = kb.texts[it.text_id];
          if (t) {
            var cl = kb.classics[t.classic_id];
            if (cl) { ownCls += cl.name + '、'; }
          }
        }
      }
      var hRef = h.source_ref || '';
      cands.push(tokenOverlap(tagClassic, ownCls));
      cands.push(tokenOverlap(tagClassic, hRef));
    }
    var m = cands[0];
    for (var q = 1; q < cands.length; q++) { if (cands[q] > m) { m = cands[q]; } }
    return m;
  }

  /* 需求匹配度：整名层面 + 逐字层面的加权。chars 为 hanzi 行数组。 */
  function demandMatch(chars, kb, tagText, tagImagery, tagSem, tagClassic) {
    var per = [];
    for (var i = 0; i < chars.length; i++) {
      per.push(matchOne(kb, chars[i], tagText, tagImagery, tagSem, tagClassic));
    }
    var whole = 0.0;
    for (var j = 0; j < per.length; j++) { if (per[j] > whole) { whole = per[j]; } }
    var avg = 0.0;
    if (per.length) {
      var s = 0.0;
      for (var k = 0; k < per.length; k++) { s += per[k]; }
      avg = s / per.length;
    }
    var both = 1.0;
    for (var q = 0; q < per.length; q++) { if (!(per[q] > 0)) { both = 0.0; break; } }
    var raw = 0.45 * whole + 0.35 * avg + 0.20 * both;
    if (raw <= 0) { return 0.12; }
    return Math.min(1.0, 0.25 + 0.75 * raw);
  }

  return {
    tokens: tokens,
    tokenOverlap: tokenOverlap,
    matchOne: matchOne,
    demandMatch: demandMatch
  };
});
