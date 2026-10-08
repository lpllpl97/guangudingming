# -*- coding: utf-8 -*-
"""
取名接口适配层：把取名引擎挂到任意 Python http.server 服务上。

两种用法：

（一）挂进现有的 6600 服务（方案 A）——不动解卦逻辑，只在 server.py 里加两行：

    from naming.api import NamingAPI, register
    API = NamingAPI(os.path.join(ROOT, "naming", "db", "naming.db"))
    register(Handler, API)          # 放在 Handler 类定义之后、run() 之前

    register() 会包装 Handler.do_GET / do_POST：
      · /api/naming/*            由取名 API 处理
      · /naming 或 /naming.html  由既有的静态文件逻辑处理（把 self.path 改掉即可）

（二）独立取名服务（方案 B）——直接用 mobile/server.py。

设计约束：只用标准库；不修改宿主类的任何既有行为；命名库路径必须在静态根之外。
"""
import json, os, re, sys, time, uuid, threading

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJ = os.path.dirname(_HERE)
if os.path.join(_PROJ, 'engine') not in sys.path:
    sys.path.insert(0, os.path.join(_PROJ, 'engine'))

from engine import (KnowledgeBase, NamingRequest, generate, ENGINE_VERSION,  # noqa: E402
                    SURNAME_PY)

DEFAULT_DB = os.path.join(_PROJ, 'db', 'naming.db')
DEFAULT_WEB = os.path.join(_PROJ, 'web')


class NamingAPI:
    """取名接口集合。宿主只需实现 _json(obj, code) 与 self.headers / self.rfile。"""

    def __init__(self, db_path=DEFAULT_DB, data_dir=None, web_dir=DEFAULT_WEB,
                 serve_prefix='/naming', log_cb=None):
        self.kb = KnowledgeBase(db_path)
        self.web_dir = web_dir
        self.serve_prefix = serve_prefix
        self.data_dir = data_dir or os.path.join(_PROJ, 'data')
        os.makedirs(self.data_dir, exist_ok=True)
        self.req_file = os.path.join(self.data_dir, 'requests.json')
        self.fav_file = os.path.join(self.data_dir, 'favorites.json')
        self.log_cb = log_cb
        self._lock = threading.Lock()

    # ---------------- 持久化 ----------------
    def _load(self, path, default):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (OSError, ValueError):
            return default

    def _save(self, path, obj):
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    def _log(self, kind, handler, extra=None):
        if not self.log_cb:
            return
        try:
            self.log_cb(kind, handler, extra)
        except Exception:
            pass

    # ---------------- 选项 ----------------
    def options_payload(self):
        kb = self.kb
        styles = [r['style'] for r in kb.query(
            'SELECT style, COUNT(*) c FROM hanzi WHERE style IS NOT NULL GROUP BY style ORDER BY c DESC')]
        groups = [{'code': r['group_code'], 'name': r['group_name']} for r in kb.query(
            'SELECT group_code, group_name FROM demand_tag GROUP BY group_code ORDER BY group_code')]
        tags = {}
        for r in kb.query('SELECT tag_id, group_code, user_phrase, risk_note, priority_code '
                          'FROM demand_tag ORDER BY group_code, tag_id'):
            tags.setdefault(r['group_code'], []).append(r)
        return {
            'object_types': ['人名', '笔名/艺名', '品牌/产品', '空间/项目'],
            'genders': ['中性', '偏男性', '偏女性'],
            'given_len': [1, 2],
            'styles': styles,
            'goal_groups': groups,
            'goal_tags': tags,
            # 前端「义」「象」面板直接用的选项清单
            'goal_options': [t['user_phrase'] for t in tags.get('G3', [])],
            'imagery_options': [t['user_phrase'] for t in tags.get('G4', [])],
            'style_options': [t['user_phrase'] for t in tags.get('G4S', [])] or styles,
            'principles': [{'id': r['principle_id'], 'name': r['name'], 'original': r['original_text'],
                            'meaning': r['rule_meaning'], 'input': r['product_input'],
                            'char_count': len(kb.principle_chars.get(r['principle_id'], []))}
                           for r in kb.query('SELECT * FROM naming_principle ORDER BY principle_id')],
            'surnames': sorted(SURNAME_PY.keys()),
            'engine_version': ENGINE_VERSION,
            'knowledge_version': kb.meta.get('knowledge_version'),
            # 给人看的版本号（与 Excel 对应，如 1.27）；knowledge_version 是内部结构版本
            'kb_version': kb.meta.get('kb_version'),
        }

    def principles_payload(self):
        guides = {}
        try:
            for r in self.kb.query('SELECT * FROM principle_guide'):
                d = dict(r)
                d['fields'] = json.loads(d.pop('fields_json') or '[]')
                guides[d['principle_id']] = d
        except Exception:
            pass
        out = []
        for r in self.kb.query('SELECT * FROM naming_principle ORDER BY principle_id'):
            pid = r['principle_id']
            g = guides.get(pid, {})
            item = {
                'id': pid, 'name': r['name'], 'original': r['original_text'],
                'meaning': r['rule_meaning'], 'input': r['product_input'],
                'rule': r['product_rule'], 'source': r['source_ref'],
                'example_chars': [self.kb.hanzi[c]['char']
                                  for c in self.kb.principle_chars.get(pid, [])][:24],
                'char_count': len(self.kb.principle_chars.get(pid, [])),
            }
            for k in ('user_intro', 'user_what', 'user_ask', 'user_example', 'why',
                      'panel_title', 'panel_note', 'no_input', 'fields'):
                item[k] = g.get(k)
            item['char_count'] = len(self.kb.principle_chars.get(pid, []))
            out.append(item)
        return out

    # ---------------- 候选序列化 ----------------
    def candidate_payload(self, it):
        kb = self.kb
        chars = []
        for h in it['chars']:
            cites, conflicts = kb.best_citation(h['char_id'])
            chars.append({
                'char': h['char'], 'pinyin': h['pinyin'], 'tone': h['tone'],
                'strokes': h['strokes'], 'structure': h['structure'], 'radical': h['radical'],
                'meaning': h['modern_meaning'], 'imagery': h['culture_imagery'],
                'persona': h['persona_semantic'], 'style': h['style'],
                'rare': h['rare_code'], 'commonness': h['commonness_code'],
                'gender_bias': h['gender_bias'], 'evidence': h['evidence_code'],
                'citation_status': h['citation_status'],
                'principles': [{'id': p, 'name': kb.principles[p]['name'], 'basis': b}
                               for p, b in kb.char_principle.get(h['char_id'], [])],
                'citation': cites,
                'evidence': kb.evidence_chain(h['char_id']),
            })
        return {
            'id': it.get('id'),
            'given_name': it['given_name'],
            'full_name': it['full_name'],
            'score': it['score'],
            'score_detail': it['score_detail'],
            'principles': [{'id': p, 'name': n, 'basis': b} for p, n, b in it['principles']],
            'chars': chars,
            'explanation': it['explanation'],
            'warns': it['warns'],
            'rules_hit': it['rules_hit'],
            'notes': it['notes'],
            'semantics': it.get('semantics', []),
        }

    # ---------------- 请求构造 ----------------
    @staticmethod
    def _as_list(v):
        if v is None or v == '':
            return []
        if isinstance(v, list):
            return v
        if isinstance(v, str):
            s = v.strip()
            if s.startswith('['):
                try:
                    return json.loads(s)
                except ValueError:
                    pass
            return [x for x in re.split(r'[,，\s]+', s) if x]
        return list(v)

    def mk_req(self, d, seed=None):
        return NamingRequest(
            surname=d.get('surname', ''), given_len=d.get('given_len', 2),
            object_type=d.get('object_type', '人名'), gender=d.get('gender', '中性'),
            goal_tags=self._as_list(d.get('goal_tags')), styles=self._as_list(d.get('styles')),
            principles=self._as_list(d.get('principles')),
            birth_facts=d.get('birth_facts', ''), generation_char=d.get('generation_char', ''),
            fixed_chars=d.get('fixed_chars', ''), avoid_chars=d.get('avoid_chars', ''),
            allow_rare=bool(d.get('allow_rare')), seed=seed if seed is not None else d.get('seed'),
            top_n=int(d.get('top_n', 6) or 6), raw_input=d.get('raw_input', ''),
            diversity=d.get('diversity', 0.6),
            borrow_words=d.get('borrow_words', ''),
            imagery_hint=d.get('imagery_hint', ''))

    # ---------------- 路由 ----------------
    def handle_get(self, path, query, handler):
        """返回 True 表示已处理。"""
        kb = self.kb
        q = lambda k, d='': (query.get(k) or [d])[0]
        if path == '/api/naming/options':
            handler._json(self.options_payload())
            return True
        if path == '/api/naming/principles':
            handler._json(self.principles_payload())
            return True
        if path == '/api/naming/tags':
            g = q('group')
            sql = ('SELECT * FROM demand_tag' + (' WHERE group_code=?' if g else '')
                   + ' ORDER BY group_code, tag_id')
            handler._json(kb.query(sql, (g,) if g else ()))
            return True
        if path == '/api/naming/candidates':
            cid = q('id')
            db = self._load(self.req_file, {})
            for rec in db.values():
                for c in rec.get('candidates', []):
                    if c.get('id') == cid:
                        handler._json(c)
                        return True
                for c in (rec.get('history') or {}).values():
                    if c.get('id') == cid:
                        handler._json(c)
                        return True
            handler._json({'error': 'candidate not found'}, 404)
            return True
        if path == '/api/naming/favorites':
            handler._json(self._load(self.fav_file, []))
            return True
        return False

    def handle_post(self, path, body, handler, req_ctx):
        """返回 True 表示已处理。"""
        if path == '/api/naming/requests':
            self.create_request(body, handler, req_ctx)
            return True
        parts = path.strip('/').split('/')
        if len(parts) == 5 and parts[:3] == ['api', 'naming', 'requests'] \
                and parts[4] in ('generate', 'regenerate'):
            self.do_generate(parts[3], body, handler, req_ctx, regen=(parts[4] == 'regenerate'))
            return True
        if path == '/api/naming/favorites':
            self.toggle_favorite(body, handler)
            return True
        if path == '/api/naming/feedback':
            self._log('feedback', req_ctx, {'data': body})
            handler._json({'ok': True})
            return True
        return False

    # ---------------- 业务 ----------------
    def create_request(self, body, handler, req_ctx):
        rid = 'req_' + uuid.uuid4().hex[:12]
        req = self.mk_req(body)
        with self._lock:
            db = self._load(self.req_file, {})
            db[rid] = {'request_id': rid, 'created_at': time.strftime('%F %T'),
                       'input': req.to_dict(), 'candidates': [], 'seed': req.seed,
                       'engine_version': ENGINE_VERSION,
                       'knowledge_version': self.kb.meta.get('knowledge_version')}
            self._save(self.req_file, db)
        handler._json({'request_id': rid, 'request': req.to_dict()})

    def do_generate(self, rid, body, handler, req_ctx, regen=False):
        db = self._load(self.req_file, {})
        rec = db.get(rid)
        if not rec:
            handler._json({'error': 'request not found'}, 404)
            return
        merged = dict(rec['input'])
        merged.update({k: v for k, v in (body or {}).items() if v not in (None, '')})
        seed = (body or {}).get('seed')
        if regen and seed is None:
            seed = (rec.get('seed') or 0) + 1
        req = self.mk_req(merged, seed=seed)
        exclude = set((body or {}).get('exclude') or [])
        t0 = time.time()
        res = generate(self.kb, req, return_rejected=True)
        if not res.get('ok'):
            handler._json(res, 400)
            return
        out = []
        for it in res['candidates']:
            if it['given_name'] in exclude:
                continue
            c = self.candidate_payload(it)
            c['id'] = 'cand_' + uuid.uuid4().hex[:10]
            out.append(c)
        res['candidates'] = out
        with self._lock:
            rec = db.get(rid)
            rec['candidates'] = out
            hist = rec.setdefault('history', {})
            for c in out:
                hist[c['id']] = c
            if len(hist) > 120:
                for k in list(hist.keys())[:len(hist) - 120]:
                    hist.pop(k, None)
            rec['seed'] = req.seed
            rec['last_generated_at'] = time.strftime('%F %T')
            self._save(self.req_file, db)
        self._log('generate', req_ctx, {
            'request_id': rid, 'surname': req.surname,
            'principles': ','.join(p['id'] for p in res['principle_hits']),
            'n': len(out), 'ms': int((time.time() - t0) * 1000)})
        handler._json(res)

    def toggle_favorite(self, body, handler):
        cid = (body or {}).get('candidate_id')
        if not cid:
            handler._json({'error': 'candidate_id required'}, 400)
            return
        favs = self._load(self.fav_file, [])
        if any(f['candidate_id'] == cid for f in favs):
            favs = [f for f in favs if f['candidate_id'] != cid]
            action = 'removed'
        else:
            favs.append({'candidate_id': cid, 'full_name': (body or {}).get('full_name', ''),
                         'at': time.strftime('%F %T')})
            action = 'added'
        self._save(self.fav_file, favs)
        handler._json({'ok': True, 'action': action, 'count': len(favs)})


# ---------------------------------------------------------------- 宿主挂载
def register(handler_cls, api, page_routes=None):
    """
    把取名 API 挂到一个已有的 http.server 请求处理类上。
    不改变宿主任何既有行为：未命中取名路由时，原逻辑照常执行。
    """
    page_routes = page_routes or {'/naming': '/naming.html', '/naming/': '/naming.html'}
    orig_get = handler_cls.do_GET
    orig_post = handler_cls.do_POST
    try:
        from urllib.parse import urlparse, parse_qs
    except ImportError:  # pragma: no cover
        import urlparse as _u
        urlparse, parse_qs = _u.urlparse, _u.parse_qs

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p in page_routes:
            self.path = page_routes[p]
            return orig_get(self)
        if p.startswith('/api/naming/'):
            if api.handle_get(p, parse_qs(u.query), self):
                return
        return orig_get(self)

    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        if p.startswith('/api/naming/'):
            body = _read_body(self)
            if api.handle_post(p, body, self, self):
                return
        return orig_post(self)

    handler_cls.do_GET = do_GET
    handler_cls.do_POST = do_POST
    return handler_cls


def _read_body(handler):
    try:
        n = int(handler.headers.get('Content-Length', 0) or 0)
    except (TypeError, ValueError):
        n = 0
    if n <= 0:
        return {}
    try:
        return json.loads(handler.rfile.read(n).decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return {}
