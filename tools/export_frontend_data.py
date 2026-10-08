# -*- coding: utf-8 -*-
"""把知识库导出成前端可直接用的数据文件（纯静态 PWA 的数据层）。

为什么要有这一步：
  PWA 里没有服务器，浏览器要知道的每个字、每条引文、每条线索都得随页面下发。
  导出必须是**无损**的（全表、全列、全行），否则界面上会静默缺内容——比如漏了原文表，
  所有引文就从"原文可核"退回"文化约定"，而这种错误肉眼很难发现。

三个模式：
  python tools/export_frontend_data.py           导出（默认），写入 web/kbdata/kb.js
  python tools/export_frontend_data.py --check    只检查已导出的数据是否与数据库一致
                                                  （防"改了库忘了导"、防版本号对不上）
  python tools/export_frontend_data.py --verify   数据充分性验证：拿引擎真实生成的名字，
                                                  只用导出的数据（不碰数据库）去还原它引用的每一项
                                                  （拼音/声调/笔画/结构/五类归属/引文/书名/语义…）

输出：web/kbdata/kb.js（给 <script src> 直接加载，内容就是全部知识库数据）
      为什么不用 .json：mobile/server.py 的守卫拦所有 .json 静态文件（见下面 OUT 处的说明），
      本地服务上会 403、Pages 上却正常，属于最难查的一类不一致。
"""
import hashlib
import json
import os
import sqlite3
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(ROOT, 'db', 'naming.db')
# 为什么是 .js 而不是 .json（两条都踩过）：
#   1) mobile/server.py 的 BLOCKED_SUFFIX 里有 '.json'——为了挡住 data/*.json 与数据库，
#      但会连带挡住 web/ 下任何 .json 静态文件，本地服务上取数据直接 403，
#      而 GitHub Pages 上完全正常（Pages 没有守卫）。这种"线上好、本地坏"最难查。
#   2) 顺带还避开 '/data/' 这个被禁的路径片段。
# 用 .js 还有个好处：页面用 <script src> 直接加载，不需要 fetch、没有异步、
# 不受同源/CORS 影响，file:// 打开也能用——这也正是同事那套 js/data/*.js 的做法。
OUT = os.path.join(ROOT, 'web', 'kbdata', 'kb.js')
GLOBAL_NAME = '__KB__'
JS_PREFIX = ('/* 观古定名知识库数据（由 tools/export_frontend_data.py 生成，请勿手改）\n'
             ' * 用法：页面用 <script src="kbdata/kb.js"></script> 加载，然后读 window.%s\n'
             ' * 重新生成：python tools/export_frontend_data.py\n'
             ' */\nwindow.%s = ' % (GLOBAL_NAME, GLOBAL_NAME))

# 只在服务端运行期写入、与"生成名字"无关的表，不下发
SERVER_STATE = {'naming_request', 'naming_candidate', 'generation_log'}

# 这些表一旦漏掉，界面上会静默缺内容（不是报错，是"看起来正常但依据没了"）
KEY_TABLES = {
    'hanzi': '字库（拼音/声调/笔画/结构/语义/五类归属/引文）',
    'original_text': '原文库（引文可核的依据）',
    'classic': '古籍（引文出自哪本书）',
    'principle_char': '五类归属',
    'principle_guide': '五类面板的用户向说明',
    'semantic': '语义分类',
    'semantic_char': '语义 → 字',
    'fact_lexicon': '出生事实词库（信）',
    'fact_char': '事实 → 字',
    'imagery_cue': '意象线索（象）',
    'goal_affinity': '目标亲和力（义）',
    'homophone_word': '谐音词表（防「招待」这类）',
    'risk_lexicon': '风险词表',
    'taboo_char': '六忌表',
    'rule': '规则闸门',
    'score_dimension': '评分维度与权重',
    'demand_tag': '需求标签',
    'naming_principle': '五类原则总表',
    'meta_version': '版本信息',
}


def db_sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def read_db(con):
    names = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    tables, counts = {}, {}
    for t in names:
        if t in SERVER_STATE:
            continue
        cur = con.execute('SELECT * FROM ' + t)
        cols = [d[0] for d in cur.description]
        tables[t] = [dict(zip(cols, r)) for r in cur.fetchall()]
        counts[t] = len(tables[t])
    return tables, counts


def engine_version():
    """引擎版本以 engine.py 的常量为准——meta_version 里那行是上次构库时写死的，会过期。"""
    sys.path.insert(0, os.path.join(ROOT, 'engine'))
    try:
        import engine as _eng
        return _eng.ENGINE_VERSION
    except Exception:
        return ''


def build_payload():
    con = sqlite3.connect(DB)
    tables, counts = read_db(con)
    con.close()
    meta = {r['key']: r['value'] for r in tables.get('meta_version', [])}
    payload = {
        '_meta': {
            'format': 'guandingming-kb/1',
            'exported_at': time.strftime('%Y-%m-%d %H:%M:%S'),
            'db_sha256': db_sha(DB),
            'row_counts': counts,
            'tables': sorted(tables),
            # 页面页脚要显示的两个版本号：知识库用"给人看的"kb_version（如 1.27）
            'kb_version': meta.get('kb_version') or meta.get('knowledge_version', ''),
            'schema_version': meta.get('knowledge_version', ''),
            # 引擎返回里带 knowledge_version（内部结构版本）。前端要与 Python 版逐字段对齐，
            # 所以必须导出去——第一版漏了它，JS 侧取到 undefined、JSON 直接把键丢掉，
            # 端到端对拍立刻报"字段集不同"。
            'knowledge_version': meta.get('knowledge_version', ''),
            'engine_version': engine_version(),
        }
    }
    payload.update(tables)
    return payload, counts


def stats(payload):
    raw = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    import gzip
    return len(raw), len(gzip.compress(raw, 9))


def write_js(payload):
    """写成 .js（赋给全局变量），供 <script src> 直接加载。"""
    body = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    # 数据里若出现 </script> 会截断内联脚本；这里是外链文件，但仍做最小转义以防万一
    body = body.replace('</', '<\\/')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(JS_PREFIX + body + ';\n')


def load_kb(path=None):
    """读回导出的数据（兼容 .js 包装与纯 .json 两种形态）。"""
    path = path or OUT
    with open(path, encoding='utf-8') as f:
        txt = f.read()
    i, j = txt.find('{'), txt.rfind('}')
    if i < 0 or j < 0:
        raise ValueError('文件里找不到 JSON 主体：%s' % path)
    return json.loads(txt[i:j + 1])


def do_export():
    payload, counts = build_payload()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    write_js(payload)
    raw, gz = stats(payload)
    print('已导出：%s' % OUT)
    print('  %d 张表、%d 行' % (len(counts), sum(counts.values())))
    print('  %.0f KB（gzip 后 %.0f KB，Pages 会自动压缩）' % (raw / 1024.0, gz / 1024.0))
    print()
    print('  分表行数：')
    for t in sorted(counts, key=lambda x: -counts[x]):
        print('    %-20s %5d' % (t, counts[t]))
    missing = [t for t in KEY_TABLES if t not in counts]
    if missing:
        print()
        print('  [!!] 关键表缺失：%s' % '、'.join(missing))
        return 1
    print()
    print('  [OK] %d 张关键内容表全部导出：%s' % (len(KEY_TABLES), '、'.join(sorted(KEY_TABLES))))
    m = payload['_meta']
    print('  [OK] 版本：知识库 V%s（内部结构 %s）、引擎 %s'
          % (m['kb_version'], m['schema_version'], m['engine_version']))
    return 0


def do_check():
    if not os.path.exists(OUT):
        print('[!!] 还没有 %s，请先跑一次导出' % OUT)
        return 1
    with open(OUT, encoding='utf-8') as f:
        payload = load_kb(OUT)
    con = sqlite3.connect(DB)
    _, counts = read_db(con)
    con.close()
    ok = True
    m = payload.get('_meta', {})
    if m.get('db_sha256') != db_sha(DB):
        print('[!!] 数据库已变，但 kb.js 还是旧的（哈希不一致）→ 请重新导出')
        ok = False
    # 版本号也要一起失效检查，否则会出现"库升到 V1.28、页面还显示 V1.27"
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    meta = {r['key']: r['value'] for r in con.execute('SELECT * FROM meta_version')}
    con.close()
    want_kb = meta.get('kb_version') or meta.get('knowledge_version', '')
    if m.get('kb_version') != want_kb:
        print('[!!] 版本号不一致：库 %s / json %s' % (want_kb, m.get('kb_version')))
        ok = False
    if m.get('engine_version') != engine_version():
        print('[!!] 引擎版本不一致：代码 %s / json %s' % (engine_version(), m.get('engine_version')))
        ok = False
    for t, n in sorted(counts.items()):
        have = len(payload.get(t, []))
        if have != n:
            print('[!!] %s：库 %d 行 / json %d 行' % (t, n, have))
            ok = False
    if ok:
        print('[OK] %s 与数据库一致（%d 张表、%d 行）'
              % (os.path.basename(OUT), len(counts), sum(counts.values())))
        return 0
    return 1


def do_verify():
    """数据充分性：用引擎生成真实候选，再**只靠 kb.js** 还原解释里用到的每一项。"""
    if not os.path.exists(OUT):
        print('[!!] 还没有 %s，请先跑一次导出' % OUT)
        return 1
    with open(OUT, encoding='utf-8') as f:
        kb = load_kb(OUT)

    sys.path.insert(0, os.path.join(ROOT, 'engine'))
    from engine import KnowledgeBase, NamingRequest, generate

    hanzi = {r['char']: r for r in kb['hanzi']}
    by_cid = {r['char_id']: r for r in kb['hanzi']}
    texts = {r['text_id']: r for r in kb.get('original_text', [])}
    classics = {r['classic_id']: r for r in kb.get('classic', [])}
    pchar = {}
    for r in kb.get('principle_char', []):
        pchar.setdefault(r['char_id'], set()).add(r['principle_id'])
    print('kb.js 已载入：hanzi %d、original_text %d、classic %d、principle_char %d'
          % (len(hanzi), len(texts), len(classics), len(kb.get('principle_char', []))))

    # 用真实引擎生成若干候选（覆盖五类里的几类）
    real = KnowledgeBase(DB)
    cases = [
        NamingRequest(surname='林', raw_input='希望孩子聪慧好学、性格温润，有远大志向', top_n=3),
        NamingRequest(surname='李', fixed_chars='知', principles=['F02'], top_n=3),
        NamingRequest(surname='王', principles=['F04'], borrow_words='玉', top_n=3),
        NamingRequest(surname='张', principles=['F01'], birth_facts='冬天出生，下雪天', top_n=3),
        NamingRequest(surname='陈', principles=['F03'], imagery_hint='山岳', top_n=3),
    ]
    checked = missing = 0
    cit_links = 0
    problems = []
    for req in cases:
        res = generate(real, req)
        for c in res.get('candidates', []):
            for h in c['chars']:
                checked += 1
                row = hanzi.get(h['char'])
                if not row:
                    missing += 1
                    problems.append('字「%s」不在 kb.js 的 hanzi 里' % h['char'])
                    continue
                # 解释里会用到的字段，逐个确认能从 json 取到
                for field in ('pinyin', 'tone', 'strokes', 'structure', 'culture_imagery',
                              'persona_semantic', 'gender_bias'):
                    if row.get(field) in (None, ''):
                        problems.append('「%s」缺字段 %s' % (h['char'], field))
                if not pchar.get(row['char_id']):
                    problems.append('「%s」在 principle_char 里没有五类归属' % h['char'])
                # 引文可核的字：citation 里是竖线分隔的 original_text.text_id，
                # 必须能在 kb.js 的 original_text / classic 里一路走通。
                # （这里曾经用不存在的列名去取 id，条件永远不成立，等于没查——所以下面
                #   单独计数 cit_links，用来证明这段检查真的执行过。）
                cit = (row.get('citation') or '').strip()
                if cit:
                    for tid in [x for x in cit.split('|') if x]:
                        cit_links += 1
                        t = texts.get(tid)
                        if t is None:
                            problems.append('「%s」引文 id=%s 在 original_text 里找不到'
                                            % (h['char'], tid))
                            missing += 1
                            continue
                        if not (t.get('content') or '').strip():
                            problems.append('「%s」的引文 %s 内容为空' % (h['char'], tid))
                        cid = t.get('classic_id')
                        if cid and cid not in classics:
                            problems.append('「%s」引文 %s 所属 classic_id=%s 不在 classic 表'
                                            % (h['char'], tid, cid))
                            missing += 1
    print('检查了 %d 个字（来自 %d 组真实生成的候选）' % (checked, len(cases)))
    print('其中走过引文链的字-引文对应关系：%d 条（这条链路必须不为 0，否则等于没查）'
          % cit_links)
    if cit_links == 0:
        print('[!!] 一条引文链都没走到——说明这轮生成的候选里没有带引文的字，'
              '样本不足以证明引文数据完整，请换个用例重跑')
        return 1
    if problems:
        print()
        print('[!!] 发现 %d 个问题（前 12 条）：' % len(problems))
        for p in problems[:12]:
            print('   · ' + p)
        return 1
    print()
    print('[OK] 这些候选用到的每一项都能只从 kb.js 还原（无缺字段、无悬空引文）')
    print('[OK] 结论：kb.js 在你已测试的取名路径上是**数据充分**的')
    print()
    print('注意：这只证明"数据够用"，不证明"逻辑已移植"。逻辑移植后的对拍见 276 组测试。')
    return 0


def main():
    if '--check' in sys.argv:
        sys.exit(do_check())
    if '--verify' in sys.argv:
        sys.exit(do_verify())
    sys.exit(do_export())


if __name__ == '__main__':
    main()
