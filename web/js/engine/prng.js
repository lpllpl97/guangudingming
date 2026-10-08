/* 与 CPython 完全一致的伪随机数（MT19937）——引擎移植能否"逐字节对拍"的关键。
 *
 * 为什么必须自己实现：
 *   引擎里有两处用到 random：
 *     · engine.py:913  rng_pool.shuffle(组)   —— 打散同档字，避免所有用户拿到同一批头部字
 *     · engine.py:1583 rng.random() 排序键    —— 决定组合的考察顺序，进而影响取前 600 与最终候选
 *   如果 JS 这边用 Math.random 或另一个 PRNG，候选**顺序**必然不同，
 *   于是"同输入同输出"这条产品承诺在网页版就断了，对拍也只能退化成"集合相同"。
 *   所以这里按 CPython 的算法原样实现：MT19937 + init_by_array 播种 + genrand_res53 +
 *   getrandbits / _randbelow / shuffle，做到与 Python 逐位相同。
 *
 * 已核对的关键细节：
 *   · seed 是 int 时 CPython 走 init_by_array；本项目 seed = md5(...)[:8] 是 < 2^32 的正整数，
 *     所以 key 数组恒为 1 个 32 位字（小端）。
 *   · 负数 seed 取绝对值（本项目用不到，但保持一致）。
 *   · shuffle 用的是 _randbelow（getrandbits 拒绝采样），不是 random()。
 *
 * 用法：
 *   浏览器：<script src="js/engine/prng.js"></script> → window.GDMRandom
 *   Node  ：const R = require('./web/js/engine/prng.js'); R.create(42).random()
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  else { root.GDMRandom = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var N = 624, M = 397;
  var MATRIX_A = 0x9908b0df, UPPER_MASK = 0x80000000, LOWER_MASK = 0x7fffffff;

  function MT(seed) {
    this.mt = new Array(N);
    this.mti = N + 1;
    this.seed(seed);
  }

  MT.prototype._initGenrand = function (s) {
    var mt = this.mt;
    mt[0] = s >>> 0;
    for (var i = 1; i < N; i++) {
      var prev = mt[i - 1];
      mt[i] = (Math.imul(1812433253, (prev ^ (prev >>> 30))) + i) >>> 0;
    }
    this.mti = N;
  };

  MT.prototype._initByArray = function (key) {
    var mt = this.mt;
    this._initGenrand(19650218);
    var i = 1, j = 0, k = Math.max(N, key.length);
    for (; k; k--) {
      var prev = mt[i - 1];
      mt[i] = (((mt[i] ^ Math.imul((prev ^ (prev >>> 30)), 1664525)) >>> 0)
        + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) { j = 0; }
    }
    k = N - 1;
    for (; k; k--) {
      var p2 = mt[i - 1];
      mt[i] = (((mt[i] ^ Math.imul((p2 ^ (p2 >>> 30)), 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  };

  MT.prototype.seed = function (a) {
    if (a === undefined || a === null) { a = Date.now(); }
    if (typeof a === 'number') {
      // CPython：int 种子取绝对值后按 32 位小端字拆成 key 数组
      var n = Math.abs(Math.trunc(a));
      var key = [];
      do {
        key.push(n % 4294967296 >>> 0);
        n = Math.floor(n / 4294967296);
      } while (n > 0);
      this._initByArray(key);
    } else {
      this._initGenrand(0);
    }
    return this;
  };

  MT.prototype.genrandUint32 = function () {
    var mt = this.mt, y;
    if (this.mti >= N) {
      var kk;
      for (kk = 0; kk < N - M; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      for (; kk < N - 1; kk++) {
        y = ((mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK)) >>> 0;
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      }
      y = ((mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK)) >>> 0;
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX_A : 0)) >>> 0;
      this.mti = 0;
    }
    y = mt[this.mti++];
    y ^= (y >>> 11);
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    y = (y ^ (y >>> 18)) >>> 0;
    return y >>> 0;
  };

  /* CPython random.random() = genrand_res53 */
  MT.prototype.random = function () {
    var a = this.genrandUint32() >>> 5;      // 27 bits
    var b = this.genrandUint32() >>> 6;      // 26 bits
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  };

  function bitLength(n) {
    var k = 0;
    while (n > 0) { n = Math.floor(n / 2); k++; }
    return k;
  }

  /* CPython getrandbits(k)，k<=32（本项目用不到更大的） */
  MT.prototype.getrandbits = function (k) {
    if (k <= 0) { return 0; }
    if (k > 32) { throw new Error('getrandbits: 只实现了 k<=32（本项目用不到更大）'); }
    return this.genrandUint32() >>> (32 - k);
  };

  /* CPython _randbelow_with_getrandbits */
  MT.prototype.randbelow = function (n) {
    if (n <= 0) { throw new Error('randbelow: n 必须为正'); }
    var k = bitLength(n);
    var r = this.getrandbits(k);
    while (r >= n) { r = this.getrandbits(k); }
    return r;
  };

  /* CPython random.shuffle：从末尾往前，用 _randbelow 取交换位置 */
  MT.prototype.shuffle = function (x) {
    for (var i = x.length - 1; i > 0; i--) {
      var j = this.randbelow(i + 1);
      var t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  };

  return {
    create: function (seed) { return new MT(seed); },
    MT: MT
  };
});
