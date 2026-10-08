/* 命名请求对象 —— NamingRequest（engine.py:456-490）的 JavaScript 移植。
 *
 * 一处**故意的不完整**：seed 的派生（engine.py:512 `_derive_seed`）依赖 MD5，
 * 尚未移植。所以这里要求显式传入 seed；不传就直接报错，而不是退回 Math.random 或
 * 某个"看起来也行"的值——那会让网页版与 Python 版悄悄产生不同的候选顺序，
 * 属于最难发现的一类偏差。MD5 我会在"请求/生成"那一并补上并单独对拍。
 *
 * 用法：const { makeRequest } = require('./web/js/engine/request.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMRequest = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEP = '、,，;；:：/|·-—\\ \t\u3000';

  function isHanzi(c) { return c >= '\u4e00' && c <= '\u9fff'; }

  function hanziOnly(s) {
    var out = [];
    var t = String(s || '');
    for (var i = 0; i < t.length; i++) { if (isHanzi(t[i])) { out.push(t[i]); } }
    return out;
  }

  function dropped(s) {
    var out = [];
    var t = String(s || '');
    for (var i = 0; i < t.length; i++) {
      if (!isHanzi(t[i]) && SEP.indexOf(t[i]) < 0) { out.push(t[i]); }
    }
    return out;
  }

  /* 种子派生（engine.py:512-522）：请求内容 → MD5 → 前 8 位十六进制。
     用户不填种子时靠它决定同档字的打散顺序，因此必须与 Python 逐位一致。 */
  function deriveSeed(req) {
    var md5 = (typeof module === 'object' && module.exports)
      ? require('./md5.js').md5 : root.GDMMd5.md5;
    var key = [
      req.surname, String(req.givenLen), req.gender, req.objectType,
      (req.goalTags || []).slice().sort().join(','),
      (req.styles || []).slice().sort().join(','),
      (req.principles || []).slice().sort().join(','),
      req.birthFacts, req.generationChar,
      (req.fixedChars || []).join(''),
      Object.keys(req.avoidChars || {}).sort().join(''),
      req.allowRare ? '1' : '0', req.rawInput,
      (req.borrowWords || []).join(',')
    ].join('|');
    return parseInt(md5(key).slice(0, 8), 16);
  }

  /* 请求字典（NamingRequest.to_dict）：两个"被过滤掉什么"的诊断字段不进去。 */
  function toDict(req) {
    return {
      surname: req.surname, given_len: req.givenLen, object_type: req.objectType,
      gender: req.gender, goal_tags: (req.goalTags || []).slice(),
      styles: (req.styles || []).slice(), principles: (req.principles || []).slice(),
      birth_facts: req.birthFacts, generation_char: req.generationChar,
      fixed_chars: (req.fixedChars || []).join(''),
      avoid_chars: Object.keys(req.avoidChars || {}).sort().join(''),
      allow_rare: req.allowRare, diversity: req.diversity, seed: req.seed,
      top_n: req.topN, raw_input: req.rawInput,
      borrow_words: (req.borrowWords || []).join(','), imagery_hint: req.imageryHint
    };
  }

  function makeRequest(o) {
    o = o || {};
    var fixed = o.fixed_chars !== undefined ? o.fixed_chars : (o.fixedChars || '');
    var avoid = o.avoid_chars !== undefined ? o.avoid_chars : (o.avoidChars || '');
    var borrow = o.borrow_words !== undefined ? o.borrow_words : (o.borrowWords || '');
    if (Object.prototype.toString.call(borrow) === '[object Array]') { borrow = borrow.join(','); }
    var req = {
      surname: String(o.surname || '').trim(),
      givenLen: parseInt(o.given_len !== undefined ? o.given_len : (o.givenLen || 2), 10) || 2,
      objectType: o.object_type || '人名',
      gender: o.gender || '中性',
      goalTags: o.goal_tags || o.goalTags || [],
      styles: o.styles || [],
      principles: o.principles || [],
      birthFacts: String(o.birth_facts !== undefined ? o.birth_facts : (o.birthFacts || '')).trim(),
      generationChar: String(o.generation_char !== undefined
        ? o.generation_char : (o.generationChar || '')).trim(),
      fixedChars: hanziOnly(fixed),
      avoidChars: {},
      fixedDropped: dropped(fixed),
      avoidDropped: dropped(avoid),
      allowRare: !!o.allow_rare,
      seed: (o.seed === undefined || o.seed === null) ? null : o.seed,
      topN: parseInt(o.top_n || o.topN || 8, 10) || 8,
      rawInput: o.raw_input !== undefined ? o.raw_input : (o.rawInput || ''),
      imageryHint: String(o.imagery_hint !== undefined ? o.imagery_hint : (o.imageryHint || '')).trim(),
      diversity: (o.diversity === undefined || o.diversity === null) ? 0.6 : Number(o.diversity)
    };
    hanziOnly(avoid).forEach(function (c) { req.avoidChars[c] = true; });
    req.borrowWords = String(borrow || '').split(/[,，、\s]+/).filter(function (w) { return !!w; });
    if (req.seed === null) { req.seed = deriveSeed(req); }
    return req;
  }

  return {
    makeRequest: makeRequest, deriveSeed: deriveSeed, toDict: toDict, isHanzi: isHanzi
  };
});
