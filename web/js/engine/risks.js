/* 规则闸门 —— engine.py:702-750（谐音滑窗）+ 935-1008（check_risks）的移植。
 *
 * 这是"硬拦截"的地方：谐音不吉、负面语义、避用字、生僻叠加会直接淘汰候选；
 * 其余（多音字、六忌、谐音联想）只提示并扣分。
 *
 * 必须照抄的点：
 *   · 谐音是**整名滑窗**，不是只看名字本体——「李想→理想」和「李昭黛→招待」都要抓到；
 *   · 滑窗长度按 kb.hp_exact 的音节数集合遍历（不是 1..len），顺序影响结果列表顺序；
 *   · 命中列表按"贬义优先、精确优先"排序，rules_hit 最后要去重并排序。
 *
 * 用法：const { checkRisks, homophoneHits } = require('./web/js/engine/risks.js')
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMRisks = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 同 score.js：factory 作用域里没有外层的 root 参数，浏览器路径需要它取全局模块
  var root = (typeof globalThis !== 'undefined') ? globalThis : this;

  function dep(name) {
    if (typeof module === 'object' && module.exports) { return require('./' + name + '.js'); }
    return root[{ pinyin: 'GDMPinyin', surnames: 'GDMSurnames',
      phonetics: 'GDMPhonetics' }[name]];
  }
  var PY = dep('pinyin');
  var SN = dep('surnames');
  var PH = dep('phonetics');

  /* 整名（姓+名）任意连续 N 个音节的谐音命中。
     given 可以是字数组，也可以是带 pinyin/tone 的对象数组。 */
  function homophoneHits(kb, req, given) {
    var table = kb.homophone;
    if (!table || !table.length || !given) { return []; }
    var seq = [];
    var sp = SN.TABLE[req.surname];
    var spy = sp ? sp[0] : null, stone = sp ? sp[1] : null;
    if (spy) { seq.push([PY.key(spy, stone), PY.toneless(spy)]); }
    var list = (typeof given === 'string') ? given.split('') : given;
    for (var i = 0; i < list.length; i++) {
      var h = list[i];
      if (typeof h === 'object' && h !== null) {
        if (!h.pinyin) { return []; }
        seq.push([PY.key(h.pinyin, h.tone), PY.toneless(h.pinyin)]);
      } else {
        var cid = kb.charByChar[h];
        if (!cid) { return []; }
        var hh = kb.hanzi[cid];
        if (!hh || !hh.pinyin) { return []; }
        seq.push([PY.key(hh.pinyin, hh.tone), PY.toneless(hh.pinyin)]);
      }
    }
    var out = [], seen = {};
    // kb.hpExact 的键是音节数；Python 里 kb.hp_exact 是 dict，这里是同样的键集合
    var lens = Object.keys(kb.hpExact).map(Number).sort(function (a, b) { return a - b; });
    for (var li = 0; li < lens.length; li++) {
      var n = lens[li];
      if (n > seq.length) { continue; }
      var exactIdx = kb.hpExact[n] || {};
      var looseIdx = kb.hpLoose[n] || {};
      for (var s = 0; s + n <= seq.length; s++) {
        var win = seq.slice(s, s + n);
        var exact = win.map(function (x) { return x[0]; }).join('');
        var w = exactIdx[exact];
        var level = 'exact';
        if (!w) {
          w = looseIdx[win.map(function (x) { return x[1]; }).join('')];
          level = 'loose';
        }
        if (!w || seen[w.word]) { continue; }
        seen[w.word] = true;
        out.push({ word: w.word, kind: w.kind, level: level,
          severity: w.severity_code, note: w.note || '' });
      }
    }
    // 贬义优先、精确匹配优先（Python 的 sort 稳定，同键保持上面的遍历顺序）
    out.sort(function (a, b) {
      var ka = (a.kind === 'negative' ? 0 : 1), kb2 = (b.kind === 'negative' ? 0 : 1);
      if (ka !== kb2) { return ka - kb2; }
      var la = (a.level === 'exact' ? 0 : 1), lb = (b.level === 'exact' ? 0 : 1);
      return la - lb;
    });
    return out;
  }

  /* 返回 {blocked, rejects, warns, rules, penalty} */
  function checkRisks(kb, req, given, chars, hpHits) {
    var rejects = [], warns = [], rulesHit = [];
    var penalty = 0.0;
    var full = req.surname + given;

    var kinds = Object.keys(kb.risk);
    for (var ki = 0; ki < kinds.length; ki++) {
      var kind = kinds[ki], table = kb.risk[kind];
      if (kind === 'homophone_combo') {
        if (table[given]) {
          rejects.push('谐音陷阱：' + given + ' 与常用负面词"' + given + '"同形同音');
          rulesHit.push('G008');
        }
      } else if (kind === 'negative_char') {
        var chs = String(given).split('');
        for (var ci = 0; ci < chs.length; ci++) {
          var ch = chs[ci];
          if (table[ch]) {
            if (full === ch || given === ch) {
              rejects.push('负面语义：' + ch);
              rulesHit.push('G009');
            } else {
              warns.push('"' + ch + '"字现代语义偏负面，需结合语境确认');
              penalty += 6.0;
              rulesHit.push('G013');
            }
          }
        }
      }
      // taboo_objects：需具体词表，暂只做提示（与 Python 一致，什么都不做）
    }
    if (kb.risk.homophone_combo && kb.risk.homophone_combo[full]) {
      rejects.push('姓氏联读形成负面词：' + full);
      rulesHit.push('G008');
    }
    // 生僻叠加
    var nRare = 0;
    for (var i = 0; i < chars.length; i++) { if (chars[i].rare_code === '高') { nRare++; } }
    if (nRare >= 2) {
      rejects.push('两字均为高生僻度，可读性与输入风险过高');
      rulesHit.push('G023');
    }
    // 同音堆叠
    var pys = [];
    for (i = 0; i < chars.length; i++) {
      if (chars[i].pinyin) { pys.push(PH.stripTone(chars[i].pinyin)); }
    }
    if (pys.length >= 2) {
      var allSame = true;
      for (i = 1; i < pys.length; i++) { if (pys[i] !== pys[0]) { allSame = false; break; } }
      if (allSame) {
        warns.push('名字两字完全同音');
        penalty += 8.0;
        rulesHit.push('G012');
      }
    }
    // 多音字提示
    var POLY = '长行和乐重还都朝';
    for (i = 0; i < chars.length; i++) {
      if (POLY.indexOf(chars[i].char) >= 0) {
        warns.push('"' + chars[i].char + '"为多音字，建议向用户确认读音');
        penalty += 3.0;
        rulesHit.push('G012');
      }
    }
    // 《左传》六忌软提示（不淘汰，只提示）
    for (i = 0; i < chars.length; i++) {
      var tb = kb.taboo[chars[i].char_id];
      if (tb) {
        warns.push('“' + chars[i].char + '”字义本身为' + tb.kind + '名，触《左传》'
          + '“不以国、不以官、不以山川、不以隐疾、不以畜牲、不以器币”之忌；'
          + '作意象使用无妨，直指其名则宜避');
        rulesHit.push('G028');
      }
    }
    // 用户避用字
    for (i = 0; i < chars.length; i++) {
      if (req.avoidChars[chars[i].char]) {
        rejects.push('命中用户避用字：' + chars[i].char);
        rulesHit.push('G011');
      }
    }
    // 谐音词
    var hp = (hpHits !== undefined && hpHits !== null) ? hpHits : homophoneHits(kb, req, given);
    for (i = 0; i < hp.length; i++) {
      var h = hp[i];
      if (h.kind === 'negative' && h.level === 'exact') {
        rejects.push('谐音不吉：整名读起来像「' + h.word + '」（' + h.note + '）');
        rulesHit.push('G029');
      } else if (h.kind === 'negative') {
        warns.push('谐音风险：读音接近「' + h.word + '」，读音仅声调不同，建议换字');
        penalty += 14.0;
        rulesHit.push('G029');
      } else if (h.level === 'exact') {
        warns.push('谐音联想：整名读起来像常用词「' + h.word + '」，已优先避开');
        penalty += 10.0;
        rulesHit.push('G030');
      } else {
        warns.push('谐音联想：读音接近常用词「' + h.word + '」（仅声调不同）');
        penalty += 5.0;
        rulesHit.push('G030');
      }
    }
    // rules 去重后排序（Python：sorted(set(rules_hit))）
    var uniq = [];
    rulesHit.slice().sort().forEach(function (r) {
      if (uniq.indexOf(r) < 0) { uniq.push(r); }
    });
    return { blocked: rejects.length > 0, rejects: rejects, warns: warns,
      rules: uniq, penalty: penalty };
  }

  return { homophoneHits: homophoneHits, checkRisks: checkRisks };
});
