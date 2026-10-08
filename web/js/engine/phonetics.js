/* 音律与字形规则 —— engine/phonetics.py 的 JavaScript 移植（纯函数，无依赖）。
 *
 * 移植原则：**保持与 Python 版逐位一致**，包括运算顺序、扣分顺序与提示文案，
 * 因为 tools/duipai_gen.py 会拿同一批输入在两个实现上跑，结果必须相同（对拍）。
 * 所以这里刻意不做"顺手优化"：不改合并同类项、不改四舍五入方式、不改文案。
 *
 * 用法：
 *   浏览器：<script src="js/engine/phonetics.js"></script> → window.GDMPhonetics
 *   Node  ：const P = require('./web/js/engine/phonetics.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMPhonetics = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 带调拼音 → 无调；ü 归一到 v（与 Python 的 str.translate 表一致）
  var TONE_MAP = {
    'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
    'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
    'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
    'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
    'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
    'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v'
  };

  // 双字母声母优先匹配（顺序必须与 Python 一致）
  var INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
    'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w'];

  // 理想声调序列（与 Python 的集合逐项一致）
  var GOOD_TONE_PATTERNS = [
    [2, 4, 3], [2, 4, 2], [2, 3, 2], [2, 2, 4], [2, 1, 4], [2, 4, 1],
    [4, 2, 3], [4, 2, 1], [4, 1, 2], [4, 2, 4], [4, 3, 2], [4, 1, 3],
    [1, 2, 4], [1, 4, 3], [1, 2, 3], [1, 4, 2], [1, 3, 2],
    [3, 2, 4], [3, 4, 2], [3, 2, 1], [3, 1, 4], [3, 4, 1],
    [2, 1, 3], [4, 3, 1], [1, 3, 4]
  ];

  var TONE_NAMES = { 1: '一', 2: '二', 3: '三', 4: '四', 0: '轻' };

  function stripTone(pinyin) {
    if (!pinyin) { return ''; }
    var s = String(pinyin).trim().toLowerCase();
    var out = '';
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      out += (TONE_MAP[c] !== undefined ? TONE_MAP[c] : c);
    }
    return out;
  }

  function initial(pinyin) {
    var s = stripTone(pinyin);
    if (!s) { return ''; }
    for (var i = 0; i < INITIALS.length; i++) {
      if (s.indexOf(INITIALS[i]) === 0) { return INITIALS[i]; }
    }
    return s[0];
  }

  function sameFinal(a, b) {
    /* 韵母完全相同（同音相撞）。注意 Python 里是 bool(a) and a == b。 */
    return !!a && a === b;
  }

  function toneName(t) {
    return TONE_NAMES[t] !== undefined ? TONE_NAMES[t] : '?';
  }

  /* Python 的 '%.0f' 用的是"四舍六入五成双"，而 JS 的 Math.round 是四舍五入。
     提示文案里带了笔画均值，用错的舍入会让文案差一个字，所以单独实现。 */
  function pyFixed0(x) {
    var r = Math.round(x);
    if (Math.abs(x - Math.trunc(x)) === 0.5) {
      var f = Math.floor(x);
      r = (f % 2 === 0) ? f : f + 1;      // 取偶数
    }
    return String(r);
  }

  function clamp01(x) { return Math.max(0.0, Math.min(1.0, x)); }

  /* tones: [姓声调, 名1声调, 名2声调]，缺失项用 null/undefined 表示。返回 0~1。 */
  function scoreToneSequence(tones) {
    var known = [];
    for (var i = 0; i < tones.length; i++) { if (tones[i]) { known.push(tones[i]); } }
    if (known.length < 2) { return 0.7; }        // 数据不足给中性分

    var score = 0.45;

    // 1) 三连同调重罚
    var run = 1, maxRun = 1;
    for (var j = 1; j < known.length; j++) {
      run = (known[j] === known[j - 1]) ? run + 1 : 1;
      maxRun = Math.max(maxRun, run);
    }
    if (maxRun >= 3) { score -= 0.30; }
    else if (maxRun === 2) { score -= 0.05; }

    // 2) 声调有起伏加分
    var distinct = {};
    for (var k = 0; k < known.length; k++) { distinct[known[k]] = 1; }
    var nd = Object.keys(distinct).length;
    if (nd === known.length) { score += 0.22; }
    else if (nd === 2) { score += 0.10; }

    // 3) 落在偏好序列上（用原始 tones，要求三项都齐全）
    if (tones.length === 3 && tones[0] && tones[1] && tones[2]) {
      for (var p = 0; p < GOOD_TONE_PATTERNS.length; p++) {
        var pat = GOOD_TONE_PATTERNS[p];
        if (pat[0] === tones[0] && pat[1] === tones[1] && pat[2] === tones[2]) {
          score += 0.18;
          break;
        }
      }
    }

    // 4) 末字忌同调收尾过平
    if (known.length >= 2 && known[known.length - 1] === known[known.length - 2]) {
      score -= 0.06;
    }
    return clamp01(score);
  }

  /* 声母/韵母层面的流畅度。返回 {score, notes}。 */
  function scorePhoneticFlow(surnamePy, py1, py2) {
    var score = 1.0;
    var notes = [];
    var i0 = initial(surnamePy), i1 = initial(py1), i2 = initial(py2);
    var f1 = stripTone(py1).slice(i1.length);
    var f2 = stripTone(py2).slice(i2.length);

    if (stripTone(py1) && stripTone(py1) === stripTone(py2)) {
      score -= 0.5;
      notes.push('名字两字同音，读起来重复');
    }
    if (i1 && i2 && i1 === i2) {
      score -= 0.18;
      notes.push('两名字声母相同，音节起头偏重复');
    }
    if (sameFinal(f1, f2)) {
      score -= 0.20;
      notes.push('两名字韵母相同，收尾相撞');
    }
    if (i0 && i0 === i1) {
      score -= 0.10;
      notes.push('姓氏与首字声母相同');
    }
    return { score: Math.max(0.0, score), notes: notes };
  }

  /* 字形可用性。注意这里只传"名"的字，不含姓（与 Python 调用处一致）。 */
  function scoreGlyph(strokes, structures, rareCodes) {
    var score = 1.0;
    var notes = [];

    var st = [];
    for (var i = 0; i < strokes.length; i++) { if (strokes[i]) { st.push(strokes[i]); } }
    if (st.length) {
      var sum = 0;
      for (var j = 0; j < st.length; j++) { sum += st[j]; }
      var avg = sum / st.length;
      if (avg > 17) {
        score -= 0.20;
        notes.push('笔画偏多（平均 ' + pyFixed0(avg) + ' 画），书写负担较大');
      } else if (avg < 5) {
        score -= 0.10;
        notes.push('笔画偏少（平均 ' + pyFixed0(avg) + ' 画），字形略单薄');
      }
      var mx = st[0], mn = st[0];
      for (var k = 1; k < st.length; k++) { mx = Math.max(mx, st[k]); mn = Math.min(mn, st[k]); }
      var spread = mx - mn;
      if (st.length >= 2 && spread >= 14) {
        score -= 0.12;
        notes.push('名字内部笔画数差异过大，视觉不平衡');
      }
    }

    var stc = [];
    for (var a = 0; a < structures.length; a++) {
      if (structures[a]) { stc.push(structures[a]); }
    }
    if (stc.length >= 2) {
      var seen = {};
      for (var b = 0; b < stc.length; b++) { seen[stc[b]] = 1; }
      if (Object.keys(seen).length < stc.length) {
        score -= 0.15;
        notes.push('字形结构重复（如均为左右结构），辨识度偏低');
      }
    }

    var rareHigh = 0;
    for (var c = 0; c < rareCodes.length; c++) { if (rareCodes[c] === '高') { rareHigh++; } }
    if (rareHigh >= 1) {
      score -= 0.25;
      notes.push('含高生僻度字');
    }
    return { score: Math.max(0.0, score), notes: notes };
  }

  return {
    stripTone: stripTone,
    initial: initial,
    sameFinal: sameFinal,
    toneName: toneName,
    scoreToneSequence: scoreToneSequence,
    scorePhoneticFlow: scorePhoneticFlow,
    scoreGlyph: scoreGlyph,
    _pyFixed0: pyFixed0,
    _GOOD_TONE_PATTERNS: GOOD_TONE_PATTERNS,
    _INITIALS: INITIALS
  };
});
