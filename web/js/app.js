/* 观古定名 · 前端（原生 JS，无构建步骤）
   技术风格：同源相对路径 / 可直接改 window.__API_BASE / 无框架无打包

   结构约定：
     第二步（命名依据）= 五类卡片，最多同时选 3 项；选中哪一类就展开该类专属面板。
        · 义 面板：表达目标（chips，G3）+ 自填
        · 象 面板：文化意象（chips，G4，已细分）+ 自填
        · 信/假/类 面板：各自的输入框
     第三步 = 只有"还有什么想说的"与硬约束，不再重复第二步的选项。

   改界面时：改完 web/ 下文件，用 python tools/pack_frontend.py 打包上传即可。
   该脚本会自动把 index.html 里的 ?v= 与下面的 UI_BUILD 一起加一，
   刷新页面看页脚的「界面」编号就能确认新界面是否已生效（避免浏览器缓存误判）。
*/
(function () {
  'use strict';

  var UI_BUILD = '2026-09-22.11';      // ← 由 tools/pack_frontend.py 自动递增
  var API = (window.__API_BASE || '').replace(/\/$/, '');
  var $ = function (id) { return document.getElementById(id); };

  var state = {
    options: null,
    len: 2,
    gender: '中性',
    principles: {},      // {F01: true}
    // 点击顺序。面板按这个顺序排（先点的类别排第一），不依赖对象键顺序——
    // 取消再勾选时对象键顺序不会变，会让"先点的排第一"看起来失效。
    principleOrder: [],
    guides: {},          // {F01: {panel_title, fields:[...]}}
    chips: {},           // {goal_tags: {U131:true}, imagery_tags: {...}, style_tags: {...}}
    custom: {},          // {goal_custom:'', imagery_custom:'', birth_facts:'', ...}
    styles: {},          // 兼容旧逻辑（风格并入 chips.style_tags）
    tags: {},            // 兼容旧逻辑（目标并入 chips.goal_tags）
    requestId: null,
    lastNames: []
  };

  function pickedPrinciples() {
    return state.principleOrder.filter(function (pid) { return state.principles[pid]; });
  }

  function get(path) {
    return fetch(API + path).then(function (r) { return r.json(); });
  }
  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function tagsOf(group) {
    var o = state.options || {};
    return ((o.goal_tags || {})[group] || []);
  }

  /* ---------------- 初始化 ---------------- */
  function boot() {
    get('/api/naming/principles').then(function (list) {
      if (!list || list.error) { alert('读取命名依据失败：' + (list && list.error)); return; }
      state.guides = {};
      (list || []).forEach(function (p) { state.guides[p.id] = p; });
      renderPrinciples(list);
      renderPanels();
      showAbout(list);
    });
    get('/api/naming/options').then(function (opt) {
      if (!opt || opt.error) { alert('读取选项失败：' + (opt && opt.error)); return; }
      state.options = opt;
      // 页脚只显示"能自查"的两个号：知识库数据版本（与 Excel 一致）与界面构建号。
      // 内部结构版本 knowledge_version 仍带在接口里，放 title 里备查，不占版面。
      // 姓氏数量不展示：目前姓氏表只有百余个单姓（且无复姓），数字摆出来反而像"数据很少"，
      // 需要时再补全姓氏表，见 docs/01 的 V1.27 界面补记。
      var kbVer = opt.kb_version ? 'V' + opt.kb_version : (opt.knowledge_version || '—');
      $('verInfo').textContent = '引擎 ' + opt.engine_version + ' · 知识库 ' + kbVer +
        ' · 界面 ' + UI_BUILD;
      $('verInfo').title = '知识库结构版本：' + (opt.knowledge_version || '—');
      renderPanels();   // 选项就绪后重绘面板（chips 需要标签数据）
    }).catch(function (e) { alert('无法连接取名服务：' + e); });
  }

  /* ---------------- 五类卡片 ---------------- */
  function renderPrinciples(list) {
    $('principleList').innerHTML = list.map(function (p) {
      return '<button class="pcard" data-id="' + p.id + '">' +
        '<b>' + p.name + '</b><i>' + p.char_count + ' 字</i>' +
        '<p>' + esc(p.user_intro || p.original) + '</p>' +
        '<span class="more">查看说明 ▾</span></button>';
    }).join('');
    Array.prototype.forEach.call($('principleList').querySelectorAll('.pcard'), function (el) {
      var pid = el.getAttribute('data-id');
      el.addEventListener('click', function () {
        // 命名依据最多同时选 2 项：两个字承载不了太多意义，选多了结果会互相冲淡
        var pickedIds = pickedPrinciples();
        if (!state.principles[pid] && pickedIds.length >= 2) {
          alert('命名依据最多同时选 2 项。\n\n已经选了：' + pickedIds.map(function (id) {
            return (state.guides[id] || {}).name || id;
          }).join('、') + '\n\n两个字承载不了太多意义，建议保留最贴近的 2 项。');
          return;
        }
        state.principles[pid] = !state.principles[pid];
        if (state.principles[pid]) {
          if (state.principleOrder.indexOf(pid) < 0) { state.principleOrder.push(pid); }
        } else {
          var i = state.principleOrder.indexOf(pid);
          if (i >= 0) { state.principleOrder.splice(i, 1); }   // 取消后重新点，会排到最后
        }
        el.classList.toggle('on', state.principles[pid]);
        renderPanels();
      });
      var more = el.querySelector('.more');
      more.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var body = el.querySelector('.pbody');
        if (body) { body.remove(); more.textContent = '查看说明 ▾'; return; }
        var g = state.guides[pid] || {};
        // 精简：只留 原典 / 这一类问什么
        more.insertAdjacentHTML('beforebegin',
          '<div class="pbody">' +
          '<p>' + esc(g.original || '') + '</p>' +
          (g.user_what ? '<p>' + esc(g.user_what) + '</p>' : '') +
          '</div>');
        more.textContent = '收起说明 ▴';
      });
    });
  }

  /* ---------------- 动态面板 ---------------- */
  function chipsHtml(field) {
    var list = tagsOf(field.group);
    if (!list.length) { return '<div class="hint">（选项加载中…）</div>'; }
    var sel = state.chips[field.id] || {};
    return '<div class="chips tags" data-field="' + esc(field.id) + '">' + list.map(function (t) {
      return '<button class="chip' + (sel[t.tag_id] ? ' on' : '') + '" data-v="' + t.tag_id +
        '" title="' + esc(t.risk_note || '') + '">' + esc(t.user_phrase) + '</button>';
    }).join('') + '</div>';
  }

  function renderPanels() {
    var ids = pickedPrinciples();      // 按点击顺序：先点的类别，面板排第一
    var host = $('principlePanels');
    if (!ids.length) {
      host.innerHTML = '';
      $('principleHint').innerHTML = '未选择任何类别时，系统会按你在第三步写的期望，自动推导最贴近的命名依据。';
      return;
    }
    host.innerHTML = ids.map(function (pid) {
      var g = state.guides[pid] || {};
      var fields = g.fields || [];
      var body = fields.map(function (f) {
        if (f.type === 'chips') {
          return '<div class="field"><label>' + esc(f.label) + '</label>' +
            chipsHtml(f) + (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '</div>';
        }
        var v = state.custom[f.id] || '';
        return '<div class="field"><label>' + esc(f.label) + '</label>' +
          '<input class="panelInput" data-field="' + esc(f.id) + '" maxlength="' + (f.maxlength || 40) +
          '" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(v) + '" autocomplete="off">' +
          (f.hint ? '<div class="hint">' + esc(f.hint) + '</div>' : '') + '</div>';
      }).join('');
      return '<div class="panel" data-id="' + pid + '">' +
        '<div class="panelHead">' + esc(g.panel_title || g.name) + '</div>' +
        (g.user_what ? '<p class="panelLead">' + esc(g.user_what) + '</p>' : '') +
        body + '</div>';
    }).join('');

    // 文本输入
    Array.prototype.forEach.call(host.querySelectorAll('.panelInput'), function (inp) {
      inp.addEventListener('input', function () {
        state.custom[inp.getAttribute('data-field')] = inp.value;
      });
    });
    // chips 多选
    Array.prototype.forEach.call(host.querySelectorAll('.chips[data-field]'), function (box) {
      var fid = box.getAttribute('data-field');
      state.chips[fid] = state.chips[fid] || {};
      Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (el) {
        el.addEventListener('click', function () {
          var v = el.getAttribute('data-v');
          state.chips[fid][v] = !state.chips[fid][v];
          el.classList.toggle('on', state.chips[fid][v]);
        });
      });
    });
    $('principleHint').innerHTML = '已选 <b>' + ids.map(function (id) {
      return (state.guides[id] || {}).name || id;
    }).join(' · ') + '</b>（最多 2 项）。每个类别问的内容不同，请分别在对应面板里确认。';
  }

  function picked(fid) {
    var m = state.chips[fid] || {};
    return Object.keys(m).filter(function (k) { return m[k]; });
  }

  /* ---------------- 组装请求 ---------------- */
  // 按 tag_id 找中文短语（「假」面板选的外物是标签，引擎要的是物名本身）
  function phraseOf(tagId) {
    var g = (state.options && state.options.goal_tags) || {};
    for (var k in g) {
      if (!Object.prototype.hasOwnProperty.call(g, k)) { continue; }
      for (var i = 0; i < g[k].length; i++) {
        if (g[k][i].tag_id === tagId) { return g[k][i].user_phrase; }
      }
    }
    return '';
  }

  function payload() {
    var goalTags = picked('goal_tags');
    var imageryTags = picked('imagery_tags');
    var styleTags = picked('style_tags');
    var goalCustom = (state.custom.goal_custom || '').trim();
    var imageryCustom = (state.custom.imagery_custom || '').trim();
    // 「假」：选中的外物 + 自填，一起作为借物词传给引擎
    var borrowWords = picked('borrow_tags').map(phraseOf).filter(Boolean);
    var borrowCustom = (state.custom.borrow_custom || '').trim();
    if (borrowCustom) { borrowWords.push(borrowCustom); }
    return {
      surname: $('surname').value.trim(),
      given_len: state.len,
      gender: state.gender,
      object_type: '人名',
      goal_tags: goalTags,
      styles: styleTags,
      principles: pickedPrinciples(),
      birth_facts: (state.custom.birth_facts || '').trim(),
      generation_char: (state.custom.generation_char || '').trim(),
      borrow_words: borrowWords.join('、'),
      // 自填内容并入需求描述，供引擎做语义匹配
      raw_input: [$('rawInput').value.trim(), goalCustom, imageryCustom].filter(Boolean).join('；'),
      imagery_hint: imageryTags.join('、'),
      fixed_chars: $('fixedChars').value.trim(),
      avoid_chars: $('avoidChars').value.trim(),
      allow_rare: $('allowRare').checked,
      top_n: 6
    };
  }

  function generate(regen) {
    var p = payload();
    if (!p.surname) { alert('请先填写姓氏'); $('surname').focus(); return; }
    $('btnGenerate').disabled = true;
    $('btnGenerate').textContent = '推演中…';
    var chain;
    if (regen && state.requestId) {
      p.exclude = state.lastNames;
      chain = post('/api/naming/requests/' + state.requestId + '/regenerate', p);
    } else {
      chain = post('/api/naming/requests', p).then(function (r) {
        if (r.error) { throw new Error(r.error); }
        state.requestId = r.request_id;
        return post('/api/naming/requests/' + r.request_id + '/generate', p);
      });
    }
    chain.then(function (res) {
      $('btnGenerate').disabled = false;
      $('btnGenerate').textContent = '开始取名';
      if (!res || res.error) { alert('生成失败：' + (res && res.error)); return; }
      if (!res.candidates || !res.candidates.length) {
        alert('没有符合条件的候选，请放宽约束（如允许生僻字、取消避用字）');
        return;
      }
      state.lastNames = res.candidates.map(function (c) { return c.given_name; });
      renderResult(res);
      $('resultWrap').classList.remove('hidden');
      $('resultWrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      $('btnGenerate').disabled = false;
      $('btnGenerate').textContent = '开始取名';
      alert('请求出错：' + e.message);
    });
  }

  /* ---------------- 结果 ---------------- */
  var DIM_NAME = {
    S01: '文化证据', S02: '需求匹配', S03: '音律', S04: '字形', S05: '现代适配',
    S06: '组合互补', S07: '独特性', S08: '性别契合', S09: '命名依据', S10: '借物契合'
  };

  function bar(label, v) {
    var pct = Math.max(0, Math.min(100, v));
    return '<div class="bar"><span>' + label + '</span><span class="track"><i class="fill" style="width:' +
      pct + '%"></i></span><span>' + Math.round(pct) + '</span></div>';
  }

  function renderResult(res) {
    var ph = res.principle_hits.map(function (p) { return p.name + '（' + p.id + '）'; }).join(' · ');
    var factLine = '';
    if (res.facts_matched && res.facts_matched.length) {
      factLine = '<div class="metaRow">识别到的出生事实：' + res.facts_matched.map(function (f) {
        return '<b>' + esc(f.label) + '</b>（' + esc(f.kind) + '，命中“' + esc(f.keyword) + '”）';
      }).join('；') + '</div>';
    }
    // 提示条按类型分色：约束提示 / 单字名唯一答案 / 字库缺字
    var alerts = '';
    (res.notices || []).forEach(function (n) {
      var isMiss = /不在字库/.test(n);
      var isUnique = /答案唯一/.test(n);
      var cls = isMiss ? 'alertMiss' : (isUnique ? 'alertInfo' : 'alertWarn');
      var icon = isMiss ? '！' : (isUnique ? '✓' : '※');
      alerts += '<div class="alert ' + cls + '"><span class="alertIcon">' + icon + '</span>' +
        '<span>' + esc(n) + '</span></div>';
    });
    var tagLine = (res.goal_tags && res.goal_tags.length)
      ? '<div class="metaRow">命中的需求标签：' + esc(res.goal_tags.join('、')) + '</div>' : '';
    $('metaBar').innerHTML =
      '<div class="metaRow"><span class="metaLabel">命中的命名依据</span><b>' + esc(ph) + '</b>' +
      '<span class="metaLabel">模式</span>' + esc(res.mode) + '</div>' +
      factLine + alerts +
      '<div class="metaRow"><span class="metaLabel">候选字池</span>' + res.pool_size + ' 字' +
      '<span class="metaLabel">按规则淘汰</span>' + res.rejected_count + ' 个组合' +
      '<span class="metaLabel">耗时</span>' + res.latency_ms + ' ms</div>' +
      tagLine +
      '<div class="metaFoot">五类原则取自《左传·桓公六年》；解释中的引文均可在知识库原文表中回溯。</div>';

    $('candList').innerHTML = res.candidates.map(candHtml).join('');
    Array.prototype.forEach.call(document.querySelectorAll('.cand'), function (el) {
      el.querySelector('.btnDetail').addEventListener('click', function () { showDetail(el.getAttribute('data-id')); });
      el.querySelector('.btnFav').addEventListener('click', function () {
        post('/api/naming/favorites', { candidate_id: el.getAttribute('data-id'), full_name: el.getAttribute('data-name') })
          .then(function (r) { alert(r.action === 'added' ? '已收藏' : '已取消收藏'); });
      });
    });
  }

  function candHtml(c) {
    var bars = Object.keys(DIM_NAME).map(function (k) {
      return c.score_detail[k] != null ? bar(DIM_NAME[k], c.score_detail[k]) : '';
    }).join('');
    var chars = c.chars.map(function (h) {
      var cite;
      if (h.citation && h.citation.content) {
        cite = '原文：《' + esc((h.citation.classic || '').replace(/[《》]/g, '')) + '》' +
          esc((h.citation.chapter || '').replace(/[《》]/g, '')) + '“' + esc(h.citation.content) + '”';
      } else if (h.citation && h.citation.classic) {
        cite = '文化出处：' + esc(h.citation.classic) + '（' + esc(h.citation.level) + '级证据，原文未录入）';
      } else {
        cite = '文化约定（' + esc((h.citation && h.citation.level) || 'C') + '级证据）';
      }
      var pills = (h.principles || []).map(function (p) {
        return '<span class="pill">' + esc(p.name) + '</span>';
      }).join('');
      return '<div class="charc"><div class="h">' + esc(h.char) +
        '<span>' + esc(h.pinyin || '') + ' · ' + (h.strokes || '?') + '画 · ' + esc(h.structure || '') + '</span></div>' +
        '<div class="d">' + esc(h.meaning || '') + '<br>意象：' + esc(h.imagery || '—') +
        '<br>人格语义：' + esc(h.persona || '—') + '</div>' +
        '<div class="cite">' + pills + '<br>' + cite + '</div></div>';
    }).join('');
    var warns = (c.warns || []).map(function (w) { return '<span class="pill warn">' + esc(w) + '</span>'; }).join('');
    var notes = (c.notes || []).map(function (n) { return '<span class="pill">' + esc(n) + '</span>'; }).join('');
    return '<div class="cand" data-id="' + esc(c.id) + '" data-name="' + esc(c.full_name) + '">' +
      '<div class="candTop"><div class="candName">' + esc(c.full_name) +
      '<small>' + esc(c.principles.map(function (p) { return p.name; }).join('·')) + '类</small></div>' +
      '<div class="candScore">综合 <b>' + c.score.toFixed(1) + '</b> / 100</div></div>' +
      '<div class="bars">' + bars + '</div>' +
      '<div>' + notes + warns + '</div>' +
      '<div class="chars">' + chars + '</div>' +
      '<div class="explain">' + esc(c.explanation) + '</div>' +
      '<div class="candBtns"><button class="ghost btnDetail">查看证据链</button>' +
      '<button class="ghost btnFav">收藏</button></div></div>';
  }

  /* ---------------- 详情 ---------------- */
  function showDetail(id) {
    var el = document.querySelector('.cand[data-id="' + id + '"]');
    if (!el) { return; }
    $('detailTitle').textContent = el.querySelector('.candName').textContent.trim() + ' · 证据链';
    get('/api/naming/candidates?id=' + encodeURIComponent(id)).then(function (c) {
      var html;
      if (!c || c.error) {
        html = '未找到该候选（服务重启后需重新生成）';
      } else {
        html = '<p><b>命名依据</b>：' + c.principles.map(function (p) {
          return esc(p.name) + '——' + esc(p.basis);
        }).join('；') + '</p>';
        c.chars.forEach(function (h) {
          html += '<h4 style="margin:16px 0 6px;color:#7d6a4a">' + esc(h.char) + '　' + esc(h.pinyin || '') + '</h4>';
          html += '<p>本义：' + esc(h.meaning || '—') + '<br>文化意象：' + esc(h.imagery || '—') +
            '<br>人格语义：' + esc(h.persona || '—') + '<br>风格：' + esc(h.style || '—') +
            '　常用度：' + esc(h.commonness || '—') + '　生僻度：' + esc(h.rare || '—') +
            '　性别倾向：' + esc(h.gender_bias || '—') + '</p>';
          html += '<p><b>五类归属</b>：' + h.principles.map(function (p) {
            return esc(p.name) + '（依据：' + esc(p.basis) + '）';
          }).join('；') + '</p>';
          if (h.evidence && h.evidence.length) {
            html += '<table><tr><th>语义单元</th><th>原文ID</th><th>可核验</th></tr>';
            h.evidence.forEach(function (e) {
              html += '<tr><td>' + esc(e.semantic_name) + '</td><td>' + esc(e.text_id || '—') +
                '</td><td>' + (e.verified ? '是' : '否') + '</td></tr>';
            });
            html += '</table>';
          } else {
            html += '<p style="color:#a99c86">该字暂无逐条核验的原文语义关联，出处按文化约定处理。</p>';
          }
        });
        html += '<p style="color:#a99c86;margin-top:16px">命中规则：' + esc((c.rules_hit || []).join('、') || '—') + '</p>';
      }
      $('detailBody').innerHTML = html;
      $('detailPanel').classList.remove('hidden');
    });
  }

  /* ---------------- 取名依据说明 ---------------- */
  function showAbout(principles) {
    var rows = principles.map(function (p) {
      return '<tr><td><b>' + p.name + '</b></td><td>' + esc(p.original) + '</td><td>' +
        esc(p.user_intro || p.meaning) + '</td><td>' + esc(p.user_what || '') + '</td><td>' + p.char_count + '</td></tr>';
    }).join('');
    $('aboutBody').innerHTML =
      '<p>《左传·桓公六年》载：“名有五：有信，有义，有象，有假，有类。”' +
      '第二步可以多选，选中哪一类就在下方展开该类需要确认的内容。</p>' +
      '<table><tr><th>类别</th><th>原典表述</th><th>一句话理解</th><th>这一类问什么</th><th>可归属字数</th></tr>' +
      rows + '</table>' +
      '<h4>评分维度</h4><p>文化证据度、需求匹配度、音律、字形、现代适配、组合互补，' +
      '以及按需启用的性别契合度、命名依据契合度（信）、借物契合度（假）。' +
      '谐音陷阱与风险词表命中时直接淘汰。</p>' +
      '<h4>关于「信」</h4><p>只要你在「信」里填写了事实（如“冬天出生，下雪时”），' +
      '系统会把它识别为时令/天气/时辰/节庆，并把选字范围收敛到字库里能承载这件事的字。</p>' +
      '<h4>边界</h4><p>本程序不与算卦、起卦或卦象推导关联；不作命运、财富、疾病等吉凶预测；' +
      '引文只在知识库原文表中确有该条时才标注为“原文可核”，否则标注为文化约定。</p>';
  }

  /* ---------------- 事件绑定 ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    function bindSingle(id, key, cast) {
      Array.prototype.forEach.call($(id).querySelectorAll('.chip'), function (el) {
        el.addEventListener('click', function () {
          Array.prototype.forEach.call($(id).querySelectorAll('.chip'), function (x) { x.classList.remove('on'); });
          el.classList.add('on');
          state[key] = cast ? cast(el.getAttribute('data-v')) : el.getAttribute('data-v');
        });
      });
    }
    bindSingle('lenChips', 'len', function (v) { return parseInt(v, 10); });
    bindSingle('genderChips', 'gender');

    $('btnGenerate').addEventListener('click', function () { generate(false); });
    $('btnMore').addEventListener('click', function () { generate(true); });
    $('btnTop').addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    $('btnReset').addEventListener('click', function () {
      ['surname', 'rawInput', 'fixedChars', 'avoidChars'].forEach(function (id) { $(id).value = ''; });
      state.principles = {}; state.principleOrder = []; state.chips = {}; state.custom = {}; state.styles = {}; state.tags = {};
      state.requestId = null;
      document.querySelectorAll('.chip.on, .pcard.on').forEach(function (el) { el.classList.remove('on'); });
      ['lenChips', 'genderChips'].forEach(function (id) {
        var first = $(id).querySelector('.chip');
        $(id).querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
        first.classList.add('on');
      });
      state.len = 2; state.gender = '中性';
      renderPanels();
      $('resultWrap').classList.add('hidden');
      $('allowRare').checked = false;
    });
    $('btnAbout').addEventListener('click', function () { $('aboutModal').classList.remove('hidden'); });
    $('btnAboutClose').addEventListener('click', function () { $('aboutModal').classList.add('hidden'); });
    $('btnDetailClose').addEventListener('click', function () { $('detailPanel').classList.add('hidden'); });
    $('aboutModal').addEventListener('click', function (e) {
      if (e.target === $('aboutModal')) { $('aboutModal').classList.add('hidden'); }
    });
    boot();
  });
})();
