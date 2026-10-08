/* 浏览器内引擎适配层 —— 让界面在没有后端的情况下照常工作。
 *
 * 【为什么需要它】界面（js/app.js）是照着 REST 接口写的：启动时读 /api/naming/principles
 * 与 /api/naming/options，取名时 POST /api/naming/requests[/generate]。本机有
 * mobile/server.py 提供这些接口，但 GitHub Pages 是纯静态托管——**没有后端**，
 * 那些路径会返回 404，页面就卡在"无法连接取名服务"。
 *
 * 【做法】不改编 app.js 一行代码，而是**接管 fetch**：
 *   · 先探测真实接口是否可用（本机起服务时可用；静态托管时不可用）；
 *   · 可用 → 原样转发，行为与本机完全一致；
 *   · 不可用 → 用已经部署在站上的 JS 引擎（js/engine/*）+ 知识库数据（kbdata/kb.js）
 *     在浏览器里就地实现同一套接口。
 * 两种运行方式因此共用同一份界面、同一套引擎算法（JS 版与 Python 版经 276 组对拍
 * 验证输出一致），不存在"静态版是简化版"的问题。
 *
 * 【持久化】收藏与请求记录存 localStorage（不经过任何服务器）。与服务端不同：
 *   · 数据只在本浏览器里，换设备/清缓存不会同步；
 *   · 请求记录只保留最近 20 次，避免无限增长（服务端保留全量并写日志）。
 */
(function () {
  'use strict';

  var API_BASE = (window.__API_BASE || '').replace(/\/$/, '');
  var REQ_KEY = 'gdm.requests.v1';
  var FAV_KEY = 'gdm.favorites.v1';
  var KEEP_REQUESTS = 20;      // 本地只留最近 N 次请求

  /* ---------------- 本地存储（隐私模式/配额失败都不能让页面崩） ---------------- */
  function load(key, dflt) {
    try {
      var s = window.localStorage.getItem(key);
      return s ? JSON.parse(s) : dflt;
    } catch (e) { return dflt; }
  }
  function save(key, obj) {
    try { window.localStorage.setItem(key, JSON.stringify(obj)); return true; }
    catch (e) { return false; }
  }
  function rid(prefix) {
    var s = '';
    var chars = 'abcdef0123456789';
    for (var i = 0; i < 12; i++) { s += chars[Math.floor(Math.random() * 16)]; }
    return prefix + s;
  }

  /* ---------------- 知识库与引擎装配 ---------------- */
  var KB = null;
  var ENG = null;

  function boot() {
    if (KB) { return; }
    if (!window.__KB__) { throw new Error('知识库数据未加载（kbdata/kb.js）'); }
    KB = window.GDMKbIndex.build(window.__KB__);
    ENG = {
      gen: window.GDMGenerate, req: window.GDMRequest, exp: window.GDMExplain,
      sel: window.GDMSelect
    };
  }

  /* ---------------- 接口实现（对齐 naming/api.py） ---------------- */

  /* options_payload */
  function optionsPayload() {
    boot();
    var counts = {};
    var order = [];
    KB.hanziRows.forEach(function (h) {
      if (h.style == null || h.style === '') { return; }
      if (counts[h.style] === undefined) { counts[h.style] = 0; order.push(h.style); }
      counts[h.style]++;
    });
    // 服务端是 ORDER BY COUNT(*) DESC；同数时保持首次出现顺序（与 SQLite 扫描顺序一致）
    var styles = order.slice().sort(function (a, b) { return counts[b] - counts[a]; });

    var groupSeen = {}, groups = [];
    Object.keys(KB.tags).forEach(function (tid) {
      var t = KB.tags[tid];
      if (t.group_code && !groupSeen[t.group_code]) {
        groupSeen[t.group_code] = true;
        groups.push({ code: t.group_code, name: t.group_name });
      }
    });
    groups.sort(function (a, b) { return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0); });

    var tags = {};
    var tagIds = Object.keys(KB.tags).slice().sort(function (a, b) {
      var ga = KB.tags[a].group_code || '', gb = KB.tags[b].group_code || '';
      if (ga !== gb) { return ga < gb ? -1 : 1; }
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    tagIds.forEach(function (tid) {
      var t = KB.tags[tid];
      (tags[t.group_code || ''] = tags[t.group_code || ''] || []).push({
        tag_id: t.tag_id, group_code: t.group_code, user_phrase: t.user_phrase,
        risk_note: t.risk_note, priority_code: t.priority_code
      });
    });
    var g3 = (tags.G3 || []).map(function (t) { return t.user_phrase; });
    var g4 = (tags.G4 || []).map(function (t) { return t.user_phrase; });
    var g4s = (tags.G4S || []).map(function (t) { return t.user_phrase; });

    var prins = Object.keys(KB.principles).sort().map(function (pid) {
      var r = KB.principles[pid];
      return { id: r.principle_id, name: r.name, original: r.original_text,
        meaning: r.rule_meaning, input: r.product_input,
        char_count: (KB.principleChars[pid] || []).length };
    });

    return {
      object_types: ['人名', '笔名/艺名', '品牌/产品', '空间/项目'],
      genders: ['中性', '偏男性', '偏女性'],
      given_len: [1, 2],
      styles: styles,
      goal_groups: groups,
      goal_tags: tags,
      goal_options: g3,
      imagery_options: g4,
      style_options: g4s.length ? g4s : styles,
      principles: prins,
      surnames: Object.keys(window.GDMSurnames.TABLE).sort(),
      engine_version: KB.meta.engine_version,
      knowledge_version: KB.meta.knowledge_version,
      kb_version: KB.meta.kb_version
    };
  }

  /* principles_payload */
  function principlesPayload() {
    boot();
    var GUIDE_FIELDS = ['user_intro', 'user_what', 'user_ask', 'user_example', 'why',
      'panel_title', 'panel_note', 'no_input'];
    return Object.keys(KB.principles).sort().map(function (pid) {
      var r = KB.principles[pid];
      var g = KB.principleGuide[pid] || {};
      var item = {
        id: pid, name: r.name, original: r.original_text, meaning: r.rule_meaning,
        input: r.product_input, rule: r.product_rule, source: r.source_ref,
        example_chars: (KB.principleChars[pid] || []).slice(0, 24).map(function (cid) {
          return KB.hanzi[cid].char;
        }),
        char_count: (KB.principleChars[pid] || []).length
      };
      GUIDE_FIELDS.forEach(function (k) { item[k] = g[k] === undefined ? null : g[k]; });
      var fj = g.fields_json;
      if (typeof fj === 'string' && fj) {
        try { item.fields = JSON.parse(fj); } catch (e) { item.fields = []; }
      } else {
        item.fields = fj || [];
      }
      return item;
    });
  }

  /* candidate_payload（含每个字的引文与证据链） */
  function candidatePayload(it) {
    var chars = it.chars.map(function (h) {
      var bc = ENG.exp.bestCitation(KB, h.char_id);
      return {
        char: h.char, pinyin: h.pinyin, tone: h.tone, strokes: h.strokes,
        structure: h.structure, radical: h.radical, meaning: h.modern_meaning,
        imagery: h.culture_imagery, persona: h.persona_semantic, style: h.style,
        rare: h.rare_code, commonness: h.commonness_code, gender_bias: h.gender_bias,
        evidence: h.evidence_code, citation_status: h.citation_status,
        principles: (KB.charPrinciple[h.char_id] || []).map(function (p) {
          return { id: p[0], name: (KB.principles[p[0]] || {}).name, basis: p[1] };
        }),
        citation: bc.cites,
        evidence: ENG.exp.evidenceChain(KB, h.char_id)
      };
    });
    return {
      id: it.id === undefined ? null : it.id,
      given_name: it.given_name, full_name: it.full_name, score: it.score,
      score_detail: it.score_detail,
      principles: it.principles.map(function (p) {
        return { id: p[0], name: p[1], basis: p[2] };
      }),
      chars: chars, explanation: it.explanation, warns: it.warns,
      rules_hit: it.rules_hit, notes: it.notes, semantics: it.semantics || []
    };
  }

  /* mk_req：与 api.py 的 mk_req 同样把入参交给请求对象 */
  function mkReq(d, seed) {
    boot();
    return ENG.req.makeRequest({
      surname: d.surname || '', given_len: d.given_len || 2,
      object_type: d.object_type || '人名', gender: d.gender || '中性',
      goal_tags: asList(d.goal_tags), styles: asList(d.styles),
      principles: asList(d.principles), birth_facts: d.birth_facts || '',
      generation_char: d.generation_char || '', fixed_chars: d.fixed_chars || '',
      avoid_chars: d.avoid_chars || '', allow_rare: !!d.allow_rare,
      seed: (seed === undefined || seed === null)
        ? (d.seed === undefined || d.seed === null ? null : d.seed) : seed,
      top_n: parseInt(d.top_n || 6, 10) || 6, raw_input: d.raw_input || '',
      diversity: d.diversity === undefined ? 0.6 : d.diversity,
      borrow_words: d.borrow_words || '', imagery_hint: d.imagery_hint || ''
    });
  }

  function asList(v) {
    if (v === null || v === undefined || v === '') { return []; }
    if (Object.prototype.toString.call(v) === '[object Array]') { return v; }
    if (typeof v === 'string') {
      var s = v.trim();
      if (s.charAt(0) === '[') { try { return JSON.parse(s); } catch (e) { /* 忽略 */ } }
      return s.split(/[,，\s]+/).filter(function (x) { return !!x; });
    }
    return [v];
  }

  function createRequest(body) {
    boot();
    var id = rid('req_');
    var req = mkReq(body || {});
    var db = load(REQ_KEY, {});
    db[id] = {
      request_id: id, created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      input: ENG.req.toDict(req), candidates: [], seed: req.seed,
      engine_version: KB.meta.engine_version, knowledge_version: KB.meta.knowledge_version
    };
    trimRequests(db);
    save(REQ_KEY, db);
    return { request_id: id, request: ENG.req.toDict(req) };
  }

  function trimRequests(db) {
    var keys = Object.keys(db);
    if (keys.length <= KEEP_REQUESTS) { return; }
    keys.sort(function (a, b) {
      return String(db[a].created_at || '').localeCompare(String(db[b].created_at || ''));
    });
    keys.slice(0, keys.length - KEEP_REQUESTS).forEach(function (k) { delete db[k]; });
  }

  function doGenerate(id, body, regen) {
    boot();
    var db = load(REQ_KEY, {});
    var rec = db[id];
    if (!rec) { return { status: 404, data: { error: 'request not found' } }; }
    var merged = {};
    Object.keys(rec.input || {}).forEach(function (k) { merged[k] = rec.input[k]; });
    Object.keys(body || {}).forEach(function (k) {
      var v = body[k];
      if (v !== null && v !== undefined && v !== '') { merged[k] = v; }
    });
    var seed = body && body.seed;
    if (regen && (seed === null || seed === undefined)) { seed = (rec.seed || 0) + 1; }

    var t0 = Date.now();
    var req = mkReq(merged, seed);
    var res = ENG.gen.generate(KB, req, true);
    if (!res.ok) { return { status: 400, data: res }; }

    var exclude = (body && body.exclude) || [];
    var out = [];
    res.candidates.forEach(function (it) {
      if (exclude.indexOf(it.given_name) >= 0) { return; }
      var c = candidatePayload(it);
      c.id = rid('cand_');
      out.push(c);
    });
    res.candidates = out;
    res.latency_ms = Date.now() - t0;

    rec.candidates = out;
    rec.history = rec.history || {};
    out.forEach(function (c) { rec.history[c.id] = c; });
    var hk = Object.keys(rec.history);
    if (hk.length > 120) { hk.slice(0, hk.length - 120).forEach(function (k) { delete rec.history[k]; }); }
    rec.seed = req.seed;
    rec.last_generated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);
    save(REQ_KEY, db);
    return { status: 200, data: res };
  }

  function findCandidate(cid) {
    var db = load(REQ_KEY, {});
    var found = null;
    Object.keys(db).forEach(function (k) {
      if (found) { return; }
      var rec = db[k];
      (rec.candidates || []).forEach(function (c) { if (c.id === cid) { found = c; } });
      if (!found) {
        Object.keys(rec.history || {}).forEach(function (h) {
          if (!found && rec.history[h].id === cid) { found = rec.history[h]; }
        });
      }
    });
    return found;
  }

  function toggleFavorite(body) {
    var cid = (body || {}).candidate_id;
    if (!cid) { return { status: 400, data: { error: 'candidate_id required' } }; }
    var favs = load(FAV_KEY, []);
    var had = favs.some(function (f) { return f.candidate_id === cid; });
    var action;
    if (had) {
      favs = favs.filter(function (f) { return f.candidate_id !== cid; });
      action = 'removed';
    } else {
      favs.push({ candidate_id: cid, full_name: (body || {}).full_name || '',
        at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
      action = 'added';
    }
    var okSaved = save(FAV_KEY, favs);
    return { status: 200, data: { ok: true, action: action, count: favs.length,
      persisted: okSaved } };
  }

  /* ---------------- 路由 ---------------- */
  function handle(method, path, query, body) {
    var p = path;
    if (method === 'GET') {
      if (p === '/api/naming/options') { return { status: 200, data: optionsPayload() }; }
      if (p === '/api/naming/principles') { return { status: 200, data: principlesPayload() }; }
      if (p === '/api/naming/tags') {
        var g = query.group;
        var rows = Object.keys(KB.tags).map(function (k) { return KB.tags[k]; })
          .filter(function (t) { return !g || t.group_code === g; });
        return { status: 200, data: rows };
      }
      if (p === '/api/naming/candidates') {
        var c = findCandidate(query.id);
        return c ? { status: 200, data: c } : { status: 404, data: { error: 'candidate not found' } };
      }
      if (p === '/api/naming/favorites') { return { status: 200, data: load(FAV_KEY, []) }; }
    }
    if (method === 'POST') {
      if (p === '/api/naming/requests') { return { status: 200, data: createRequest(body) }; }
      var parts = p.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'naming'
          && parts[2] === 'requests' && (parts[4] === 'generate' || parts[4] === 'regenerate')) {
        return doGenerate(parts[3], body, parts[4] === 'regenerate');
      }
      if (p === '/api/naming/favorites') { return toggleFavorite(body); }
      if (p === '/api/naming/feedback') { return { status: 200, data: { ok: true } }; }
    }
    return null;      // 不是取名接口 → 交回原 fetch
  }

  /* ---------------- 接管 fetch ---------------- */
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!realFetch) { return; }        // 太老的浏览器：保持原样

  var modePromise = null;
  function detectMode(url) {
    // 探测一次真实接口：本机起服务时可用；静态托管时 404/超时 → 用浏览器内引擎
    if (modePromise) { return modePromise; }
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, 4000);
    modePromise = realFetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      clearTimeout(timer);
      var ct = (r.headers && r.headers.get && r.headers.get('Content-Type')) || '';
      return (r.ok && ct.indexOf('json') >= 0) ? 'server' : 'local';
    }).catch(function () {
      clearTimeout(timer);
      return 'local';
    });
    return modePromise;
  }

  function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }

  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var full = url;
    if (full.charAt(0) === '/') { full = API_BASE + full; }
    var idx = full.indexOf('/api/naming/');
    if (idx < 0) { return realFetch(input, init); }        // 与取名无关 → 原样放行

    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var path = full.slice(idx).split('?')[0];
    var query = {};
    var qs = full.slice(idx).split('?')[1];
    if (qs) {
      qs.split('&').forEach(function (kv) {
        var a = kv.split('=');
        if (a[0]) { query[decodeURIComponent(a[0])] = decodeURIComponent(a[1] || ''); }
      });
    }
    var body = null;
    if (init && init.body) {
      try { body = JSON.parse(init.body); } catch (e) { body = null; }
    }

    return detectMode(API_BASE + '/api/naming/options').then(function (mode) {
      if (mode === 'server') { return realFetch(input, init); }   // 有后端就用后端
      var out = handle(method, path, query, body);
      if (!out) { return realFetch(input, init); }
      return jsonResponse(out.data, out.status);
    });
  };

  /* ---------------- Service Worker（离线可用 / 添加到主屏幕） ---------------- */
  // 只在真正的静态站点注册。本机用 mobile/server.py 调试时不注册——否则缓存会挡住改动，
  // 造成"明明改了却没生效"这种最费时间的现象。
  (function registerSW() {
    if (!window.navigator || !('serviceWorker' in window.navigator)) { return; }
    if (typeof window.addEventListener !== 'function') { return; }
    var h = window.location ? window.location.hostname : '';
    var proto = window.location ? window.location.protocol : '';
    if (h === 'localhost' || h === '127.0.0.1' || h === '') { return; }
    if (proto !== 'http:' && proto !== 'https:') { return; }
    window.addEventListener('load', function () {
      window.navigator.serviceWorker.register('sw.js').catch(function () {
        /* 注册失败（隐私模式/旧浏览器）不影响正常使用 */
      });
    });
  })();

  // 暴露给页面/调试：显示当前用的是哪种模式
  window.__GDM_LOCAL_ENGINE__ = {
    mode: function () { return modePromise; },
    kb: function () { boot(); return KB; },
    reset: function () { try { localStorage.removeItem(REQ_KEY); localStorage.removeItem(FAV_KEY); } catch (e) {} }
  };
})();
