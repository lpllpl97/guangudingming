/* Python 的 round(x, nd) —— 评分层每个分项都要 round(...,1)，必须逐位一致。
 *
 * 为什么不能直接用 Math.round：
 *   Python 的 round 是"正确舍入 + 四舍六入五成双"：把 double 的**精确十进制展开**
 *   舍入到 nd 位小数，正好落在中点时取偶数；Math.round 是"四舍五入"（中点向上）。
 *   两者在 0.05 / 0.15 / 2.675 / 75.25 这类值上结果不同。
 *   本项目每个候选要算 10 个分项、每个都 round(...,1)，一旦有值落在中点，
 *   网页版与 Python 版就会差 0.1 分——足以让排序换位，而且极难发现。
 *
 * 做法：把 double 拆成"精确的 m × 2^e"，用 BigInt 做有理数运算，
 *      按"四舍六入五成双"求出整数结果，再拼回十进制字符串转 double。
 *      Python 的 round 返回的正是"舍入后十进制数最近的那个 double"，与之完全一致。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMPyRound = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var POW10 = [1n, 10n, 100n, 1000n, 10000n];

  function pyRound(x, nd) {
    nd = nd || 0;
    if (typeof x !== 'number' || !isFinite(x)) { return x; }
    if (x === 0) { return x; }
    var neg = x < 0;
    var ax = Math.abs(x);

    // 拆 IEEE754：ax = m × 2^e（精确）
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, ax);
    var hi = dv.getUint32(0), lo = dv.getUint32(4);
    var expBits = (hi >>> 20) & 0x7ff;
    var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    var e;
    if (expBits === 0) { e = -1074; }                 // 次正规数
    else { m |= (1n << 52n); e = expBits - 1075; }

    var num, den;
    if (e >= 0) { num = m << BigInt(e); den = 1n; }
    else { num = m; den = 1n << BigInt(-e); }

    // 求 round(ax × 10^nd)：q = floor(num×10^nd / den)，再看余数决定是否进位
    var scale = POW10[nd] || (10n ** BigInt(nd));
    var n2 = num * scale;
    var q = n2 / den;
    var r = n2 % den;
    var twice = r * 2n;
    if (twice > den || (twice === den && (q % 2n === 1n))) { q += 1n; }

    var s = q.toString();
    var out;
    if (nd === 0) {
      out = Number(s);
    } else {
      while (s.length <= nd) { s = '0' + s; }
      out = Number(s.slice(0, s.length - nd) + '.' + s.slice(s.length - nd));
    }
    return neg ? -out : out;
  }

  return { round: pyRound };
});
