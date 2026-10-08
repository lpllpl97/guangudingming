/* 拼音工具 —— engine/pinyin_util.py 的 JavaScript 移植（41 行，逐条对应）。
 *
 * 用途：把带声调的拼音拆成"无声调字母 + 声调数字"，用于谐音比对。
 * Python 侧特意让建库脚本与引擎共用同一套规则，避免"建库一套、运行一套"；
 * JS 这边同样必须一致，否则谐音查不出来（网页版会把「招待」这类名字放过去）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMPinyin = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var TONE_MARKS = {
    'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
    'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
    'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
    'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
    'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
    'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v',
    'ń': 'n', 'ň': 'n', 'ǹ': 'n', 'ḿ': 'm'
  };

  /* 去掉声调符号：'zhāo' → 'zhao' */
  function toneless(pinyin) {
    var s = pinyin || '';
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      out += (TONE_MARKS[c] !== undefined ? TONE_MARKS[c] : c);
    }
    return out.toLowerCase();
  }

  /* 无声调字母 + 声调数字：('zhāo', 1) → 'zhao1'；tone 为空则只返回字母。 */
  function key(pinyin, tone) {
    var base = toneless(pinyin);
    return base + (tone ? String(tone) : '');
  }

  return { TONE_MARKS: TONE_MARKS, toneless: toneless, key: key };
});
