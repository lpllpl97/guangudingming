# -*- coding: utf-8 -*-
"""
观古定名引擎 v0.1
主线：《左传·桓公六年》"名有五：有信，有义，有象，有假，有类"
流程（对应 R04 A01-A07）：
  需求解析 → 原则匹配 → 语义转化 → 选字 → 组合 → 规则闸门 → 评分 → 解释
默认不与算卦/卦象推导关联（rule G027）。
"""
import json, os, random, re, sqlite3, sys, threading, time, uuid
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from phonetics import (score_tone_sequence, score_phonetic_flow, score_glyph,
                       strip_tone, initial, tone_name)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_DB = os.path.join(ROOT, 'db', 'naming.db')

ENGINE_VERSION = 'naming-engine-0.3.0'

# 拼音工具（与建库共用同一套规则，避免建库/运行时两套算法）
from pinyin_util import key as pykey, toneless as pytoneless  # noqa: E402

# 事实关联强度权重：strong（事实直接对应字）> medium（典型物象）> weak（氛围类）
_FACT_W = {'strong': 1.0, 'medium': 0.7, 'weak': 0.4}

# 人工确认过的「字→语义」精确配对（来源：作者本地源数据 db/src/evidence_patch.json 的
# allow_specific；该目录未随仓库发布）
ALLOW_SPECIFIC = {
    ('知', 'SEM017'), ('山', 'SEM018'), ('明', 'SEM011'), ('思', 'SEM044'),
    ('笃', 'SEM045'), ('博', 'SEM045'), ('学', 'SEM045'), ('修', 'SEM041'),
    ('远', 'SEM041'), ('齐', 'SEM014'), ('善', 'SEM024'), ('正', 'SEM034'),
    ('行', 'SEM041'), ('生', 'SEM001'),
}

# 常见姓氏读音（引擎需要"姓+名"整体判音；未收录的姓氏按未知处理，不猜测）
SURNAME_PY = {
    '赵': ('zhào', 4), '钱': ('qián', 2), '孙': ('sūn', 1), '李': ('lǐ', 3), '周': ('zhōu', 1),
    '吴': ('wú', 2), '郑': ('zhèng', 4), '王': ('wáng', 2), '冯': ('féng', 2), '陈': ('chén', 2),
    '褚': ('chǔ', 3), '卫': ('wèi', 4), '蒋': ('jiǎng', 3), '沈': ('shěn', 3), '韩': ('hán', 2),
    '杨': ('yáng', 2), '朱': ('zhū', 1), '秦': ('qín', 2), '尤': ('yóu', 2), '许': ('xǔ', 3),
    '何': ('hé', 2), '吕': ('lǚ', 3), '施': ('shī', 1), '张': ('zhāng', 1), '孔': ('kǒng', 3),
    '曹': ('cáo', 2), '严': ('yán', 2), '华': ('huà', 4), '金': ('jīn', 1), '魏': ('wèi', 4),
    '陶': ('táo', 2), '姜': ('jiāng', 1), '戚': ('qī', 1), '谢': ('xiè', 4), '邹': ('zōu', 1),
    '喻': ('yù', 4), '柏': ('bǎi', 3), '水': ('shuǐ', 3), '窦': ('dòu', 4), '章': ('zhāng', 1),
    '云': ('yún', 2), '苏': ('sū', 1), '潘': ('pān', 1), '葛': ('gě', 3), '奚': ('xī', 1),
    '范': ('fàn', 4), '彭': ('péng', 2), '郎': ('láng', 2), '鲁': ('lǔ', 3), '韦': ('wéi', 2),
    '昌': ('chāng', 1), '马': ('mǎ', 3), '苗': ('miáo', 2), '凤': ('fèng', 4), '花': ('huā', 1),
    '方': ('fāng', 1), '俞': ('yú', 2), '任': ('rén', 2), '袁': ('yuán', 2), '柳': ('liǔ', 3),
    '唐': ('táng', 2), '罗': ('luó', 2), '薛': ('xuē', 1), '雷': ('léi', 2), '贺': ('hè', 4),
    '倪': ('ní', 2), '汤': ('tāng', 1), '滕': ('téng', 2), '殷': ('yīn', 1), '罗': ('luó', 2),
    '林': ('lín', 2), '高': ('gāo', 1), '梁': ('liáng', 2), '宋': ('sòng', 4), '郭': ('guō', 1),
    '洪': ('hóng', 2), '程': ('chéng', 2), '傅': ('fù', 4), '邓': ('dèng', 4), '丁': ('dīng', 1),
    '叶': ('yè', 4), '杜': ('dù', 4), '白': ('bái', 2), '崔': ('cuī', 1), '钟': ('zhōng', 1),
    '谭': ('tán', 2), '陆': ('lù', 4), '汪': ('wāng', 1), '石': ('shí', 2), '廖': ('liào', 4),
    '贾': ('jiǎ', 3), '夏': ('xià', 4), '田': ('tián', 2), '熊': ('xióng', 2), '孟': ('mèng', 4),
    '顾': ('gù', 4), '尹': ('yǐn', 3), '江': ('jiāng', 1), '余': ('yú', 2), '邵': ('shào', 4),
    '毛': ('máo', 2), '黎': ('lí', 2), '于': ('yú', 2), '董': ('dǒng', 3), '萧': ('xiāo', 1),
    '涂': ('tú', 2), '顾': ('gù', 4),
}

PROVINCE_CHARS = set('京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新港澳台')
# 常见国家/朝代简称，用于《左传》"不以国"边界的粗筛提示
COUNTRY_WORDS = {'中国', '华夏', '中华', '大唐', '大汉', '大秦', '大周', '先秦'}


class KnowledgeBase:
    def __init__(self, db_path=DEFAULT_DB):
        self.db_path = db_path
        self._local = threading.local()
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        self.meta = {r['key']: r['value'] for r in con.execute('SELECT * FROM meta_version')}
        self.principles = {r['principle_id']: dict(r) for r in con.execute('SELECT * FROM naming_principle')}
        self.hanzi = {r['char_id']: dict(r) for r in con.execute('SELECT * FROM hanzi')}
        self.char_by_char = {r['char']: r['char_id'] for r in con.execute('SELECT char_id, char FROM hanzi')}
        self.principle_chars = defaultdict(list)   # pid -> [char_id]
        self.char_principle = defaultdict(list)    # char_id -> [(pid, basis)]
        for r in con.execute('SELECT * FROM principle_char'):
            self.principle_chars[r['principle_id']].append(r['char_id'])
            self.char_principle[r['char_id']].append((r['principle_id'], r['basis']))
        self.tags = {r['tag_id']: dict(r) for r in con.execute('SELECT * FROM demand_tag')}
        self.semantic = {r['semantic_id']: dict(r) for r in con.execute('SELECT * FROM semantic')}
        self.texts = {r['text_id']: dict(r) for r in con.execute('SELECT * FROM original_text')}
        self.classics = {r['classic_id']: dict(r) for r in con.execute('SELECT * FROM classic')}
        self.dims = [dict(r) for r in con.execute('SELECT * FROM score_dimension ORDER BY dim_id')]
        self.rules = {r['rule_id']: dict(r) for r in con.execute('SELECT * FROM rule')}
        # 语义/原文 关联：只保留"真正挂得上"的语义
        # 判定：语义原文ID与该字 citation 相同（强证据），或语义名出现在字的人格语义/意象里
        self.char_semantics = defaultdict(list)
        q = """SELECT sc.char_id, sc.semantic_id, sc.contribution, sc.evidence_code,
                      s.name AS sname, s.text_id, s.verified, s.description
               FROM semantic_char sc JOIN semantic s ON s.semantic_id = sc.semantic_id
               JOIN hanzi h ON h.char_id = sc.char_id"""
        for r in con.execute(q):
            h = self.hanzi[r['char_id']]
            own = ''.join(filter(None, [h['persona_semantic'], h['culture_imagery'], h['modern_meaning']]))
            cit_ids = set((h['citation'] or '').split('|'))
            sname = r['sname'] or ''
            contrib = r['contribution'] or ''
            # 路线一（强）：字的 citation 指向该语义的原文，且语义名/贡献与该字自述相符
            route1 = bool(r['text_id']) and r['text_id'] in cit_ids and \
                bool(sname) and (sname in own or contrib in own or sname in (h['source_ref'] or ''))
            # 路线二（强）：语义名与来源说明/字义完全一致，属于同一语义单元
            route2 = bool(sname) and sname in (h['source_ref'] or '')
            # 路线三（人工确认）：精确配对白名单
            route3 = (h['char'], r['semantic_id']) in ALLOW_SPECIFIC
            if not (route1 or route2 or route3):
                continue
            item = dict(r)
            if not item['text_id'] and h['citation']:
                first = [x for x in h['citation'].split('|') if x]
                if first:
                    item['text_id'] = first[0]
            self.char_semantics[r['char_id']].append(item)
        # 风险词
        self.risk = defaultdict(dict)
        for r in con.execute('SELECT * FROM risk_lexicon'):
            self.risk[r['kind']][r['term']] = r
        # 出生事实词库（'信'类的落地依据）
        self.facts = []
        try:
            for r in con.execute('SELECT * FROM fact_lexicon'):
                d = dict(r)
                d['keywords'] = [x for x in (r['keywords'] or '').split(',') if x]
                self.facts.append(d)
            self.fact_char = defaultdict(dict)     # fact_id -> {char_id: strength}
            for r in con.execute('SELECT * FROM fact_char'):
                self.fact_char[r['fact_id']][r['char_id']] = r['strength']
        except sqlite3.OperationalError:
            self.facts, self.fact_char = [], defaultdict(dict)
        self.char_fact = defaultdict(dict)         # char_id -> {fact_id: strength}
        for fid, m in self.fact_char.items():
            for cid, st in m.items():
                self.char_fact[cid][fid] = st
        # 目标标签 ↔ 字义亲和力（profile=贴切 / avoid=冲突），用于避免"要求活泼却给出静、淑"
        self.affinity = defaultdict(lambda: {'profile': [], 'avoid': []})
        try:
            for r in con.execute('SELECT * FROM goal_affinity'):
                self.affinity[r['tag_id']][r['kind']].append(r['cue'])
        except sqlite3.OperationalError:
            pass
        # 《左传》六忌用字（软提示，不淘汰）
        self.taboo = {}
        try:
            for r in con.execute('SELECT * FROM taboo_char'):
                self.taboo[r['char_id']] = {'kind': r['kind'], 'note': r['note']}
        except sqlite3.OperationalError:
            pass
        # 意象选项 → 字族线索：选「四季」就真的从四季字族里选字
        self.imagery_cues = {}
        self.imagery_cue_options = []
        try:
            for r in con.execute('SELECT * FROM imagery_cue ORDER BY cue_id'):
                opt = r['option']
                if opt not in self.imagery_cues:
                    self.imagery_cues[opt] = []
                    self.imagery_cue_options.append(opt)
                self.imagery_cues[opt].append({
                    'label': r['label'],
                    'keywords': [k for k in (r['keywords'] or '').split(',') if k],
                    'chars': set(r['chars'] or '')})
        except sqlite3.OperationalError:
            pass
        # 谐音词表：避免名字读出来像常用词或贬义词
        # 按"词长 + 拼音"建索引，判定时直接查表——逐个候选扫全表会把耗时抬 4 倍。
        self.homophone = []
        self.hp_exact = {}      # {音节数: {带声调拼音: 词条}}
        self.hp_loose = {}      # {音节数: {无声调拼音: 词条}}
        try:
            for r in con.execute('SELECT * FROM homophone_word'):
                d = dict(r)
                self.homophone.append(d)
                n = d['syllables']
                self.hp_exact.setdefault(n, {}).setdefault(d['pinyin'], d)
                self.hp_loose.setdefault(n, {}).setdefault(d['pinyin_loose'], d)
        except sqlite3.OperationalError:
            pass
        con.close()

    # ---------- 查询接口（线程安全：每线程一个连接，供 HTTP 服务复用） ----------
    @property
    def con(self):
        c = getattr(self._local, 'con', None)
        if c is None:
            c = sqlite3.connect(self.db_path)
            c.row_factory = sqlite3.Row
            self._local.con = c
        return c

    def query(self, sql, args=()):
        return [dict(r) for r in self.con.execute(sql, args)]

    # ---------- 证据链 ----------
    def evidence_chain(self, char_id):
        """返回该字的证据链：语义 → 原文 → 古籍（同名语义只保留一条）。"""
        out = []
        seen = set()
        for sc in self.char_semantics.get(char_id, []):
            if sc['semantic_id'] in seen:
                continue
            seen.add(sc['semantic_id'])
            sem = self.semantic.get(sc['semantic_id'])
            if not sem:
                continue
            txt = self.texts.get(sem['text_id']) if sem['text_id'] else None
            cls = self.classics.get(txt['classic_id']) if txt and txt['classic_id'] else None
            out.append({
                'semantic_id': sem['semantic_id'],
                'semantic_name': sem['name'],
                'contribution': sc['contribution'],
                'text_id': sem['text_id'],
                'content': txt['content'] if txt else None,
                'chapter': txt['chapter'] if txt else None,
                'classic': cls['name'] if cls else None,
                'verified': bool(sem['verified']),
            })
        return out

    def best_citation(self, char_id):
        """
        该字最可信的出处。返回 (cites, conflicts)。
        cites: level/classic/chapter/content/semantic/text_id/in_db
        conflicts: 与主流语境不一致的语义（用于提示"换语境"而非当作出处）
        """
        chain = [c for c in self.evidence_chain(char_id) if c['verified'] and c['content']]
        # 排序：语义名出现在原文里 > 语义名与该字人格语义重合 > 语义ID
        h = self.hanzi[char_id]
        own = (h['persona_semantic'] or '') + (h['modern_meaning'] or '') + (h['culture_imagery'] or '')
        cit_ids = [x for x in (h['citation'] or '').split('|') if x]

        def rank(c):
            name = c['semantic_name'] or ''
            score = 0
            if name and name in (c['content'] or ''):
                score += 10
            if name and name in own:
                score += 6
            if (c['contribution'] or '') and c['contribution'] in own:
                score += 4
            if c['text_id'] and cit_ids and c['text_id'] == cit_ids[0]:
                score += 8
            elif c['text_id'] and c['text_id'] in cit_ids:
                score += 3
            return (-score, c['semantic_id'])
        chain.sort(key=rank)
        # 字库自带的 citation（人工核校层）优先：它明确指定了这个字要用哪条原文，
        # 不应被语义推断出来的其他句子覆盖（否则"崟"会被绑到"泠然"那句上）。
        for tid in cit_ids:
            t0 = self.texts.get(tid)
            if not t0 or not (t0['content'] or '').strip():
                continue
            cls0 = self.classics.get(t0['classic_id'])
            sem0 = next((c['semantic_name'] for c in chain if c['text_id'] == tid), None)
            conflicts = [c for c in chain if c['text_id'] != tid
                         and not (c['semantic_name'] or '') in own]
            return ({'level': h['evidence_code'] or 'A', 'classic': cls0['name'] if cls0 else None,
                     'chapter': t0['chapter'], 'content': t0['content'], 'semantic': sem0,
                     'text_id': tid, 'in_db': True}, conflicts)
        conflicts = [c for c in chain[1:] if not (c['semantic_name'] or '') in own
                     and not (c['semantic_name'] or '') in (c['content'] or '')]
        if chain:
            c = chain[0]
            return ({'level': 'A', 'classic': c['classic'], 'chapter': c['chapter'],
                     'content': c['content'], 'semantic': c['semantic_name'],
                     'text_id': c['text_id'], 'in_db': True}, conflicts)
        # 字库自带 citation：只有在原文库里真的存在才当作"可核验出处"
        for tid in [x for x in (h['citation'] or '').split('|') if x]:
            t = self.texts.get(tid)
            if t:
                cls = self.classics.get(t['classic_id'])
                return ({'level': h['evidence_code'] or 'A',
                         'classic': cls['name'] if cls else None, 'chapter': t['chapter'],
                         'content': t['content'], 'semantic': None,
                         'text_id': tid, 'in_db': True}, conflicts)
        return ({'level': h['evidence_code'] or 'C', 'classic': h['source_ref'] or None,
                 'chapter': None, 'content': None, 'semantic': None,
                 'text_id': None, 'in_db': False}, conflicts)


def match_facts(kb, text):
    """
    把用户在'信'类里填写的可核验事实映射到词库事实条目。
    返回 [(fact_id, label, kind, 命中的关键词, [char_id...])]，按命中关键词长度排序（越长越具体）。
    """
    if not text:
        return []
    hits = []
    for f in kb.facts:
        matched = [k for k in f['keywords'] if k and k in text]
        if not matched:
            continue
        matched.sort(key=len, reverse=True)
        ids = sorted(kb.fact_char.get(f['fact_id'], {}).keys())
        hits.append((f['fact_id'], f['label'], f['kind'], matched[0], ids))
    # 一个事实若被另一个更具体的事实覆盖（如"下雪"与"冬"同时命中），保留更具体的
    hits.sort(key=lambda x: (-len(x[3]), x[0]))
    keep, used_ids = [], set()
    for h in hits:
        idset = set(h[4])
        if idset and idset.issubset(used_ids) and len(idset) < 6:
            continue
        keep.append(h)
        used_ids |= idset
    return keep[:3]


def char_borrow_hit(h, borrow_words):
    """该字是否落到用户指定的外物上（'假'类的核心判定）。"""
    return char_borrow_score(h, borrow_words) > 0


# 借物关联族：用户说"借琴"，同族的瑟/弦/徽/磬… 同样承载该物之义，
# 否则借物字池会窄到只剩一个字（实测"借琴"只能用琴，六条候选反复用同一字）
BORROW_FAMILY = {
    '玉': ('玉', '瑾', '瑜', '珩', '瑶', '琼', '璐', '珊', '琳', '玥', '珮', '琚', '璧', '璋', '圭',
           '琛', '瑄', '玦', '珅', '玙', '璞', '玑', '琢', '瑞', '瑶'),
    '兰': ('兰', '芷', '蕙', '荃', '蘅', '荪', '葳'),
    '竹': ('竹', '筠', '简', '笙', '箫', '箦', '笔'),
    '松': ('松', '柏'),
    '舟': ('舟', '帆', '楫', '棹', '舷', '航'),
    '砚': ('砚', '墨', '笔', '笺', '简', '篆', '铭', '案', '函'),
    '琴': ('琴', '瑟', '弦', '徽', '磬', '笙', '箫', '钟', '鼓'),
    '鼎': ('鼎', '尊', '爵', '彝', '铉', '鉴'),
    '镜': ('鉴', '镜'),
    '水': ('水', '清', '澄', '渊', '川', '江', '海', '澜', '泓', '溪', '沅', '湘', '沐', '湛', '澈', '汐', '湄', '漪', '淮'),
    '山': ('山', '岳', '峰', '岑', '岩', '峻', '岚', '嵩', '岱'),
    '月': ('月', '露', '霜', '雪', '晴', '霓', '霁', '霞'),
    '云': ('云', '舒', '霄', '霞', '霓', '雯'),
    '星': ('星', '辰', '曜', '晖', '昭', '曦', '昕', '旭', '晞', '旸', '昀'),
    '花': ('兰', '芷', '蕙', '梅', '荷', '莲', '菊', '桂', '桃', '棠', '薇', '菀', '茉', '蕊', '蕾', '萱', '菱', '菡', '荃', '蘅', '荪'),
    '草': ('兰', '芷', '蕙', '薇', '菀', '苓', '芝', '荃', '蘅', '荪', '葳', '芃'),
    '木': ('松', '柏', '桐', '梧', '杉', '桂', '梅', '棠', '槐', '林', '森', '柳'),
    '光': ('明', '昭', '晖', '曜', '曦', '旭', '朗', '华', '辉', '炜', '烨', '煜', '灿', '耀', '熙', '昱'),
    '风': ('云', '舒', '朗', '岚'),
    '雨': ('霖', '泽', '润', '霁', '澄', '沐', '溦', '霈'),
    '雪': ('雪', '霜', '素', '霁', '梅'),
    '文': ('文', '章', '学', '思', '书', '墨', '笔', '简', '典', '雅'),
    '德': ('德', '仁', '义', '礼', '智', '信', '诚', '善', '正', '谦', '和'),
    # ---- 以下为「假」专用的"人造之物"族 ----
    # 象与假的分工：象取自然之象（天时/山水/草木/鸟兽），假借人造之物（器物/织物）取其文化含义。
    # 两边的选项概念不允许重复，所以器物族只在这里定义，不进意象线索表。
    '玉器': ('玉', '瑾', '瑜', '珩', '瑶', '琼', '璐', '珊', '琳', '玥', '璧', '璋', '圭', '琮',
             '璜', '琛', '瑄', '玦', '珅', '玙', '璞', '玑', '琢', '瑞', '瑛', '玮', '璟'),
    '佩饰': ('佩', '珮', '琚', '瑗', '环', '玦', '瑱', '璎', '珂', '玖', '组', '绶'),
    '礼器': ('鼎', '尊', '爵', '彝', '铉', '鉴', '簋', '觞', '瓒', '珪', '鬲', '甑'),
    '乐器': ('琴', '瑟', '弦', '徽', '磬', '笙', '箫', '钟', '鼓', '筝', '笛', '箜'),
    '文房': ('砚', '墨', '笔', '笺', '简', '篆', '铭', '案', '函', '卷', '纸', '帖'),
    '舟楫': ('舟', '帆', '楫', '棹', '舷', '航', '舸', '橹', '桅'),
    '织绣': ('绫', '绮', '绡', '缇', '缦', '缜', '绦', '缳', '裳', '绾', '缃', '缥', '纾', '罗', '绢'),
}


def char_borrow_score(h, borrow_words):
    """
    借物匹配分（0~2）：
      2 = 字本身就是那样东西（借"玉"用到"玉"）
      1 = 该字属于该物的关联族，或字义/人格语义直接涉及
          （借"玉"用到"瑾""瑜"；借"琴"用到"瑟""弦""徽"）
      0 = 未命中（"文化意象"这类宽泛字段不参与，否则借"玉"会匹配到所有玉石意象字）
    """
    if not borrow_words:
        return 0.0
    ch = h.get('char') or ''
    meaning = (h.get('modern_meaning') or '') + (h.get('persona_semantic') or '')
    best = 0.0
    for w in borrow_words:
        if not w:
            continue
        if w == ch:
            return 2.0
        if ch and ch in BORROW_FAMILY.get(w, ()):
            best = max(best, 1.0)
            continue
        if w in meaning:
            best = max(best, 1.0)
    return best


def goal_affinity(kb, goal_tags):
    """
    汇总用户所选目标标签的亲和力线索。
    返回 (profile 线索集, avoid 线索集, 冲突标签名列表)
    用于：选字时排除明显冲突的字、评分时对冲突字降权。
    """
    prof, avoid, labels = set(), set(), []
    for t in goal_tags or []:
        a = kb.affinity.get(t) if hasattr(kb, 'affinity') else None
        if not a:
            continue
        prof.update(a.get('profile') or [])
        avoid.update(a.get('avoid') or [])
        tag = kb.tags.get(t) or {}
        if tag.get('user_phrase'):
            labels.append(tag['user_phrase'])
    return prof, avoid, labels


def char_profile_hit(h, profile_cues):
    """该字是否命中用户所选表达目标的贴切线索（正向关联）。

    与 char_conflicts 相对：那个判"冲突"，这个判"真的对得上"。
    用户反馈过"选了目标却给不出相关的字"，所以正向关联也要能驱动选字，
    不能只是评分里的一个加项。
    """
    if not profile_cues:
        return False
    own = (str(h.get('persona_semantic') or '') + '、' + str(h.get('culture_imagery') or '')
           + '、' + str(h.get('modern_meaning') or ''))
    for cue in profile_cues:
        if cue and (cue in own):
            return True
    return False


def char_conflicts(h, avoid_cues):
    """该字是否与用户所选目标明显冲突。"""
    if not avoid_cues:
        return None
    own = (h.get('persona_semantic') or '') + '、' + (h.get('culture_imagery') or '') \
        + '、' + (h.get('modern_meaning') or '')
    for cue in avoid_cues:
        if cue and cue in own:
            return cue
    return None


def char_gender_score(h, gender):
    """性别倾向契合度：契合 1.0 / 中性 0.72 / 相反 0.35。"""
    b = h.get('gender_bias') or '中性'
    if not gender or gender == '中性':
        return 0.72 if b == '中性' else 0.6
    want = '偏女性' if gender in ('女', '偏女性', '女性') else '偏男性'
    other = '偏男性' if want == '偏女性' else '偏女性'
    if b == want:
        return 1.0
    if b == other:
        return 0.35
    return 0.72


def _norm_chapter(chapter, classic_name=None):
    """把'《论语·子张》'这类章节字段归一为'子张'，避免书名重复显示。"""
    if not chapter:
        return ''
    s = chapter.strip().strip('《》')
    if '·' in s:
        head, _, tail = s.partition('·')
        if classic_name and head.strip('《》') == classic_name.strip('《》'):
            return tail
        return s
    if classic_name and s == classic_name.strip('《》'):
        return ''          # 章节字段就是书名本身，无需重复
    return s


class NamingRequest:
    def __init__(self, surname='', given_len=2, object_type='人名', gender='中性',
                 goal_tags=None, styles=None, principles=None,
                 birth_facts='', generation_char='', fixed_chars='', avoid_chars='',
                 allow_rare=False, seed=None, top_n=8, raw_input='', diversity=0.6,
                 borrow_words='', imagery_hint=''):
        self.surname = (surname or '').strip()
        self.given_len = int(given_len or 2)
        self.object_type = object_type
        self.gender = gender
        self.goal_tags = goal_tags or []
        self.styles = styles or []
        self.principles = principles or []
        self.birth_facts = (birth_facts or '').strip()
        self.generation_char = (generation_char or '').strip()
        # 只保留汉字：姓名用字不可能包含数字/字母/标点。
        # 但过滤掉的东西必须能被上层提示出来——以前这里是纯静默过滤，
        # 用户在"必须保留的字"里打了 "Q"，结果名字里没有 Q 却毫无提示。
        # 常见分隔符（顿号/逗号/空格等）是正常输入，不算错误，不提示。
        _sep = set('、,，;；:：/|·-—\\ \t\u3000')

        def _hanzi(s):
            return [c for c in (s or '') if '\u4e00' <= c <= '\u9fff']

        def _dropped(s):
            return [c for c in (s or '')
                    if not ('\u4e00' <= c <= '\u9fff') and c not in _sep]

        self.fixed_chars = _hanzi(fixed_chars)
        self.avoid_chars = set(_hanzi(avoid_chars))
        self.fixed_dropped = _dropped(fixed_chars)
        self.avoid_dropped = _dropped(avoid_chars)
        self.allow_rare = bool(allow_rare)
        self.diversity = float(diversity if diversity is not None else 0.6)
        self.seed = seed
        self.top_n = int(top_n or 8)
        self.raw_input = raw_input
        # '假'类：用户想借哪一个外物取义（如"玉""兰""舟"）
        self.borrow_words = [w.strip() for w in re.split(r'[,，、\s]+', (borrow_words or '')) if w.strip()]
        # '象'类面板里勾选的意象词（用于加强语义匹配）
        self.imagery_hint = (imagery_hint or '').strip()
        if self.seed is None:
            self.seed = _derive_seed(self)

    def to_dict(self):
        d = dict(self.__dict__)
        # fixed_dropped / avoid_dropped 是"哪些输入被过滤掉了"的派生诊断，不是入参：
        # 不放进请求字典，避免它们出现在接口返回与 data/requests.json 里（回读时也不需要）。
        for k in ('fixed_dropped', 'avoid_dropped'):
            d.pop(k, None)
        d['avoid_chars'] = ''.join(sorted(self.avoid_chars))
        d['fixed_chars'] = ''.join(self.fixed_chars)
        d['borrow_words'] = ','.join(self.borrow_words)
        return d


def _derive_seed(req):
    import hashlib
    key = '|'.join([
        req.surname, str(req.given_len), req.gender, req.object_type,
        ','.join(sorted(req.goal_tags)), ','.join(sorted(req.styles)),
        ','.join(sorted(req.principles)), req.birth_facts, req.generation_char,
        ''.join(req.fixed_chars), ''.join(sorted(req.avoid_chars)),
        '1' if req.allow_rare else '0', req.raw_input,
        ','.join(req.borrow_words or []),
    ])
    return int(hashlib.md5(key.encode('utf-8')).hexdigest()[:8], 16)


# ---------------------------------------------------------------- 原则匹配
def match_principles(kb, req):
    """
    仅在《左传》五类原则中匹配适用项（R04 A02）。
    返回 ([(principle_id, 归属依据, 触发原因)], mode)
    说明：'信'类只要用户填了可核验事实就必须启用（这是该类成立的唯一条件）。
    """
    hits = []
    matched_facts = match_facts(kb, req.birth_facts)
    requested = [p for p in req.principles if p in kb.principles]
    tag_groups = {kb.tags[t]['group_code'] for t in req.goal_tags if t in kb.tags}
    tag_names = {kb.tags[t]['user_phrase'] for t in req.goal_tags if t in kb.tags}

    if requested:
        for pid in requested:
            hits.append((pid, '用户指定：%s' % kb.principles[pid]['rule_meaning'], '用户显式指定五类原则'))
        return hits, '用户指定'

    # F01 信：有可核验事实（出生时令/纪念事件）—— 只要填了就必须启用
    if req.birth_facts:
        if matched_facts:
            fy = '、'.join('%s（%s，命中“%s”）' % (f[1], f[2], f[3]) for f in matched_facts)
            hits.append(('F01', '用户提供可核验事实：' + req.birth_facts + '；已识别为 ' + fy,
                         '出生时令/纪念事件'))
        else:
            hits.append(('F01', '用户提供可核验事实：' + req.birth_facts, '出生时令/纪念事件'))
    # F05 类：家族传承（字辈优先；或"家庭+传承"叠加信号）
    inherit_signal = any(any(k in (n or '') for k in ('家族', '字辈', '传承', '辈分', '宗族'))
                         for n in tag_names) or ('家庭' in (req.raw_input or '') and '传承' in (req.raw_input or ''))
    if req.generation_char:
        hits.append(('F05', '用户提供字辈/家族传承字：' + req.generation_char, '家族辈分要求'))
    elif inherit_signal:
        hits.append(('F05', '用户需求标签指向家族传承', '家族传承意愿'))
    # F04 假：明确要求借物（仅在有明确指向时启用，避免默认淹没主线）
    borrow_kw = ('借物', '器物', '借玉', '玉的', '佩玉', '礼器', '以物', '假于物')
    if any(any(k in (n or '') or k in (req.raw_input or '') for k in borrow_kw) for n in tag_names):
        hits.append(('F04', '用户需求指向借外物取义', '借物命名意愿'))
    # F02 义：德性/品格/志向（主线的常备项）
    virtue_words = ('品格', '德行', '德性', '仁', '义', '智', '诚', '信', '志向', '抱负',
                    '成长', '修身', '坚韧', '温润', '聪慧', '好学', '担当', '自律', '价值',
                    '愿望', '气质', '内涵', '格局', '胸怀', '大气', '端方', '守礼')
    f02 = (tag_groups & {'G3'}) or any(any(w in (n or '') for w in virtue_words) for n in tag_names)
    if f02:
        hits.append(('F02', '用户需求指向德行与品格方向', '德性/品格/志向目标'))
    # F03 象：意象/风格
    f03 = (tag_groups & {'G4'}) or bool(req.styles) or any(
        k in (req.raw_input or '') for k in ('意象', '诗', '自然', '山水', '花木', '植物', '清雅', '飘', '意境'))
    if f03:
        hits.append(('F03', '用户需求指向自然物象与文化意象', '意象/风格偏好'))

    if not hits:
        hits = [('F02', '系统推荐：以德行品格为主线', '系统默认'),
                ('F03', '系统推荐：以自然意象为辅线', '系统默认')]
        return hits, '系统推荐'

    # 主线排序：具体依据（信/类/假）> 德性（义）> 意象（象）
    order = {'F01': 0, 'F05': 1, 'F04': 2, 'F02': 3, 'F03': 4}
    hits.sort(key=lambda x: order.get(x[0], 9))
    hits = hits[:3]
    # 若只命中了"信/类/假"这类依据型原则，补一条"义"作为主线，避免选字池过窄
    if all(h[0] in ('F01', 'F05', 'F04') for h in hits):
        hits.append(('F02', '补主线：以德行品格为语义主线', '主线补足'))
    # 过滤掉字库无可用字的空原则
    usable = [h for h in hits if kb.principle_chars.get(h[0])]
    return (usable or hits), '需求推导'


# ---------------------------------------------------------------- 需求解析
def parse_goals(kb, text, extra_text='', groups=None):
    """把自由文本映射到需求标签（R04 A01）。

    groups：只接受这些分组编码的标签（None = 不限）。
    用途：用户在「象」面板选的意象词只应解析出「文化意象」类标签，
    不应该因为"山岳"里含一个"山"字，就顺带推出「仁厚宽和」这类表达目标——
    那会让用户没选过的目标偷偷参与选字约束（实际踩过的坑）。
    """
    text = ((text or '') + '；' + (extra_text or '')).strip()
    if not text:
        return []
    scored = []
    for tid, t in kb.tags.items():
        if groups and (t['group_code'] or '') not in groups:
            continue
        score = 0
        phrase = (t['user_phrase'] or '').strip()
        if phrase and phrase in text:
            score += 5
        for field in ('semantic_map', 'imagery_hint'):
            v = (t[field] or '').strip()
            if not v or v in ('不适用', '—'):
                continue
            for tok in re.split(r'[、,，/／;；\s]+', v):
                tok = tok.strip()
                if len(tok) >= 2 and tok in text:
                    score += 2
                elif len(tok) == 1 and tok in text:
                    score += 1
        # 标签名本身
        for tok in re.split(r'[、,，/／;；\s]+', phrase):
            if len(tok) >= 2 and tok in text:
                score += 3
        if score:
            scored.append((score, tid))
    scored.sort(reverse=True)
    return [tid for _, tid in scored[:5]]


# ---------------------------------------------------------------- 意象线索
def resolve_imagery_options(kb, hint):
    """把用户填的意象文本映射到 imagery_cue 里的选项名（如「四季」）。

    用户可能写「四季」「四季、光明日晖」，也可能在自由文本框里写「想要四季的感觉」，
    这里按"选项名出现在文本里"来判定，允许多选。
    """
    text = (hint or '').strip()
    if not text:
        return []
    return [opt for opt in kb.imagery_cue_options if opt and opt in text]


def imagery_specs(kb, hint):
    """返回所选意象对应的子族规格列表；没选或选项无线索时返回 []。"""
    out = []
    for opt in resolve_imagery_options(kb, hint):
        out.extend(kb.imagery_cues.get(opt) or [])
    return out


def imagery_affinity(h, specs):
    """单字对所选意象的契合度 0~1。

    明确字表命中 → 1.0；只靠关键词命中 → 0.6~1.0（命中越多越高）。
    注意：单字关键词只在 culture_imagery（受控词表，如「风/流动」）里匹配，
    不去匹配 persona_semantic / modern_meaning 的自由文本——否则「家风」「威仪」
    会因为含「风」字被误判成"风霜雨雪"意象（这是实际踩过的坑）。
    """
    if not specs:
        return 0.0
    ch = h['char']
    imagery = str(h.get('culture_imagery') or '')
    prose = ' '.join(str(h.get(k) or '') for k in ('persona_semantic', 'modern_meaning'))
    best = 0.0
    for spec in specs:
        if ch in spec['chars']:
            return 1.0
        hits = 0
        for k in spec['keywords']:
            if not k:
                continue
            if len(k) == 1:
                hits += 1 if k in imagery else 0
            else:
                hits += 1 if (k in imagery or k in prose) else 0
        if hits:
            best = max(best, min(1.0, 0.6 + 0.2 * hits))
    return best


def cue_pool_size(kb, specs, char_ids=None):
    """所选意象在字库里可用的字数（用于判断线索是否够宽）。"""
    if not specs:
        return 0
    ids = char_ids if char_ids is not None else list(kb.hanzi.keys())
    return sum(1 for cid in ids if imagery_affinity(kb.hanzi[cid], specs) > 0)


def affinity_cached(h, specs, cache):
    """带缓存的意象契合度：同一请求里同一个字会被反复问到，重算是纯浪费。"""
    key = h['char']
    v = cache.get(key)
    if v is None:
        v = imagery_affinity(h, specs)
        cache[key] = v
    return v


# ---------------------------------------------------------------- 谐音
def homophone_hits(kb, req, given):
    """检查整名（姓+名）里任意连续 N 个音节是否撞上谐音词表里的词。

    用户反馈过「昭黛 → 招待」这类问题：两个字单看都好，连读却成了常用词或贬义词。
    因此不只看名字本体，而是滑窗比对整名的每一个连续片段——
    这样「李想 → 理想」（姓+名两音节）和「李昭黛 → 招待」（名内两音节）都能抓到。
    """
    table = getattr(kb, 'homophone', None)
    if not table or not given:
        return []
    seq = []
    spy, stone = SURNAME_PY.get(req.surname, (None, None))
    if spy:
        seq.append((pykey(spy, stone), pytoneless(spy)))
    for h in (given if isinstance(given, list) else list(given)):
        if isinstance(h, dict):
            if not h.get('pinyin'):
                return []
            seq.append((pykey(h['pinyin'], h['tone']), pytoneless(h['pinyin'])))
        else:
            ch = kb.char_by_char.get(h)
            if not ch:
                return []
            hh = kb.hanzi[ch]
            if not hh.get('pinyin'):
                return []
            seq.append((pykey(hh['pinyin'], hh['tone']), pytoneless(hh['pinyin'])))
    out, seen = [], set()
    for n in kb.hp_exact:
        if n > len(seq):
            continue
        exact_idx = kb.hp_exact.get(n) or {}
        loose_idx = kb.hp_loose.get(n) or {}
        for i in range(len(seq) - n + 1):
            win = seq[i:i + n]
            exact = ''.join(x[0] for x in win)
            w = exact_idx.get(exact)
            level = 'exact'
            if not w:
                w = loose_idx.get(''.join(x[1] for x in win))
                level = 'loose'
            if not w or w['word'] in seen:
                continue
            seen.add(w['word'])
            out.append({'word': w['word'], 'kind': w['kind'], 'level': level,
                        'severity': w['severity_code'], 'note': w['note'] or ''})
    # 贬义优先、精确匹配优先
    out.sort(key=lambda x: (0 if x['kind'] == 'negative' else 1, 0 if x['level'] == 'exact' else 1))
    return out


# ---------------------------------------------------------------- 选字
def select_chars(kb, req, principle_hits, pool_limit=70, avoid_cues=None, cue_specs=None,
                 prof_cues=None):
    avoid_cues = avoid_cues or set()
    cue_specs = cue_specs or []
    prof_cues = prof_cues or set()
    """
    按原则选字，并施加硬约束。
    '信'类被启用且识别出具体事实时，字池改为"以该事实关联字为主"——
    否则用户填的"冬天/下雪"只会被当成一句备注，选字完全不受影响。
    """
    pids = [p for p, _, _ in principle_hits]
    must_set = set(req.fixed_chars)
    if req.generation_char:
        must_set |= set(req.generation_char)
    matched_facts = match_facts(kb, req.birth_facts) if 'F01' in pids else []
    fact_id_set = {f[0] for f in matched_facts}
    fact_ids = []
    seen_f = set()
    for f in matched_facts:
        for cid in f[4]:
            if cid not in seen_f:
                seen_f.add(cid)
                fact_ids.append(cid)

    pool = []
    seen = set()

    def push(cid):
        if cid not in seen:
            seen.add(cid)
            pool.append(cid)

    if fact_ids:
        # 信类优先：事实直接对应的字 + 该事实的典型物象字
        for cid in fact_ids:
            push(cid)
        if len(pool) < 8:
            # 事实只能关联到很少的字时，再用该事实条目所属原则的字补足
            for pid in pids:
                for cid in kb.principle_chars.get(pid, []):
                    push(cid)
        for pid in pids:
            if pid == 'F01':
                continue
            for cid in kb.principle_chars.get(pid, [])[:24]:
                push(cid)
    else:
        # '假'类：借物字要从全字库召回，而不是只在 F04 的十来个字里找
        if req.borrow_words:
            for cid, h in kb.hanzi.items():
                if char_borrow_score(h, req.borrow_words) > 0:
                    push(cid)
        for pid in pids:
            for cid in kb.principle_chars.get(pid, []):
                push(cid)
        # 原则池太小时，用语义关联补字（仍可解释：该字有原文出处）
        if len(pool) < 12:
            extra = sorted(kb.char_semantics.keys(), key=lambda c: -len(kb.char_semantics[c]))
            for cid in extra:
                push(cid)
                if len(pool) >= 20:
                    break

    # 硬约束过滤
    out = []
    reject_stat = defaultdict(int)
    # 意象线索：用户选了「玉石器物」这类意象时，字族里的字可能分属别的原则
    # （玉石字大多归「假」类），只按当前原则池取字就会"字族残缺"。
    # 因此意象字族的字要从全字库召回——与「假」类借物字的处理方式一致。
    if cue_specs:
        cue_cache = {}
        cue_extra = [cid for cid, h in kb.hanzi.items()
                     if affinity_cached(h, cue_specs, cue_cache) > 0]
        cue_extra.sort(key=lambda cid: (-affinity_cached(kb.hanzi[cid], cue_specs, cue_cache),
                                        {'高': 0, '中': 1, '低': 2}.get(
                                            kb.hanzi[cid]['commonness_code'], 1)))
        for cid in cue_extra:
            push(cid)
    # 表达目标（义）的贴合字同样要从全字库召回：
    # 目标线索多是"晴/朗/柔/秀"这类字，它们未必归在当前原则的字池里，
    # 只按原则池取字会出现"选了阳光明媚，给的却是文淑、徽肃"这种脱靶。
    if prof_cues:
        prof_extra = [cid for cid, h in kb.hanzi.items() if char_profile_hit(h, prof_cues)]
        prof_extra.sort(key=lambda cid: {'高': 0, '中': 1, '低': 2}.get(
            kb.hanzi[cid]['commonness_code'], 1))
        for cid in prof_extra:
            push(cid)
    # 硬约束保留字与字辈字必须先进入池（否则"固定字"约束会静默失效）
    must = list(req.fixed_chars)
    if req.generation_char and len(req.generation_char) == 1:
        must.append(req.generation_char)
    for ch in must:
        cid = kb.char_by_char.get(ch)
        if cid and cid not in pool:
            pool.insert(0, cid)
    for cid in pool:
        h = kb.hanzi[cid]
        is_must = h['char'] in must_set
        if h['char'] in req.avoid_chars:
            reject_stat['用户避用字'] += 1
            continue
        if h['char'] == req.surname:
            reject_stat['与姓同字'] += 1
            continue
        # 用户硬指定的字（字辈/保留字）不受生僻度与风格硬约束限制
        if not is_must and not req.allow_rare and h['rare_code'] == '高':
            reject_stat['生僻度=高'] += 1
            continue
        if not is_must and h['negative_risk_code'] == '高':
            reject_stat['负面联想=高'] += 1
            continue
        if not is_must and req.gender in ('男', '偏男性') and h['gender_bias'] == '偏女性':
            reject_stat['性别倾向不符'] += 1
            continue
        if not is_must and req.gender in ('女', '偏女性') and h['gender_bias'] == '偏男性':
            reject_stat['性别倾向不符'] += 1
            continue
        # 风格偏好：命中任一即优先，不命中不淘汰（改由评分体现）
        out.append(cid)
    # 排序：必用字 > 性别契合 > 事实关联字 > 风格命中 > 证据级别
    # （性别排在事实之前：用户显式选了性别倾向时，如果事实关联字里没有契合字，
    #   也要先让契合字进入头部，再由评分决定最终组合）
    def fact_strength(cid):
        m = kb.char_fact.get(cid) or {}
        return max((_FACT_W.get(v, 0.4) for k, v in m.items() if k in fact_id_set), default=0.0)

    # 排序：必用字 > 不冲突（用户所选目标） > 性别契合 > 事实关联 > 风格 > 证据级别
    # 冲突字（如要求"活泼/大气"时的静、淑、娴）排到最后，组合自然用不到它们
    #
    # 性能：rank 只算一次并缓存。此前排序用它做 key、分组时又逐字重算一遍，
    # 加上意象契合度会按字族逐个匹配，使单次请求从 ~60ms 涨到 ~100ms。
    rank_cache = {}

    def rank(cid):
        r = rank_cache.get(cid)
        if r is not None:
            return r
        h = kb.hanzi[cid]
        style_hit = 1 if h['style'] in req.styles else 0
        must = 1 if h['char'] in must_set else 0
        fs = fact_strength(cid)
        g = char_gender_score(h, req.gender)
        bs = char_borrow_score(h, req.borrow_words)
        borrow = 1 if bs > 0 else 0
        conflict = 1 if char_conflicts(h, avoid_cues) else 0
        # 意象契合：用户选了「四季」这类意象时，命中该意象字族的字必须排在前面，
        # 否则意象只是一句备注，选字完全不受影响（用户反馈过"选四季却给江流玉石"）。
        cue = imagery_affinity(h, cue_specs)
        # 表达目标贴切度：命中用户所选目标的字排前面（与意象同样对待）
        prof = 1 if (prof_cues and char_profile_hit(h, prof_cues)) else 0
        commonness = {'高': 2, '中': 1, '低': 0}.get(h['commonness_code'], 0)
        ev = {'A': 2, 'B': 1}.get(h['evidence_code'], 0)
        r = (-must, conflict, -round(cue, 2), -prof, -borrow, -round(bs, 2), -round(g, 2),
             -round(fs, 2), -style_hit, -ev, -commonness, cid)
        rank_cache[cid] = r
        return r

    out.sort(key=rank)
    # 必用字后，同档字用种子打散：避免所有用户都拿到同一批"头部字"
    rng_pool = random.Random(req.seed ^ 0x5EED)
    must_first = [cid for cid in out if kb.hanzi[cid]['char'] in must_set]
    rest = [cid for cid in out if kb.hanzi[cid]['char'] not in must_set]
    groups, cur, curkey = [], [], None
    for cid in rest:
        k = rank(cid)[:5]
        if curkey is None or k == curkey:
            cur.append(cid)
            curkey = k
        else:
            groups.append(cur)
            cur, curkey = [cid], k
    if cur:
        groups.append(cur)
    sampled = []
    for g in groups:
        rng_pool.shuffle(g)
        sampled.extend(g)
    return (must_first + sampled)[:pool_limit], dict(reject_stat)


# ---------------------------------------------------------------- 风险
def check_risks(kb, req, given, chars, hp_hits=None):
    """返回 (是否硬拦截, 拦截原因列表, 风险提示列表, 规则命中列表, 扣分)"""
    rejects, warns, rules_hit = [], [], []
    penalty = 0.0
    full = req.surname + given
    for kind, table in kb.risk.items():
        if kind in ('homophone_combo',):
            if given in table:
                rejects.append('谐音陷阱：%s 与常用负面词"%s"同形同音' % (given, given))
                rules_hit.append('G008')
        elif kind == 'negative_char':
            for ch in given:
                if ch in table:
                    if full == ch or given == ch:
                        rejects.append('负面语义：%s' % ch)
                        rules_hit.append('G009')
                    else:
                        warns.append('"%s"字现代语义偏负面，需结合语境确认' % ch)
                        penalty += 6.0
                        rules_hit.append('G013')
        elif kind == 'taboo_objects':
            pass  # 需具体词表，暂只做提示
    # 双字名与姓氏整体：姓+名 = 常见负面词
    if full in kb.risk.get('homophone_combo', {}):
        rejects.append('姓氏联读形成负面词：%s' % full)
        rules_hit.append('G008')
    # 生僻叠加
    if sum(1 for h in chars if h['rare_code'] == '高') >= 2:
        rejects.append('两字均为高生僻度，可读性与输入风险过高')
        rules_hit.append('G023')
    # 同音堆叠
    pys = [strip_tone(h['pinyin']) for h in chars if h['pinyin']]
    if len(pys) >= 2 and len(set(pys)) == 1:
        warns.append('名字两字完全同音')
        penalty += 8.0
        rules_hit.append('G012')
    # 多音字提示
    for h in chars:
        if h['char'] in '长行和乐重还都朝':
            warns.append('"%s"为多音字，建议向用户确认读音' % h['char'])
            penalty += 3.0
            rules_hit.append('G012')
    # 《左传》六忌软提示（不淘汰，只提示）
    for h in chars:
        tb = kb.taboo.get(h['char_id'])
        if tb:
            warns.append('“' + h['char'] + '”字义本身为' + tb['kind'] + '名，触《左传》'
                         + '“不以国、不以官、不以山川、不以隐疾、不以畜牲、不以器币”之忌；'
                         + '作意象使用无妨，直指其名则宜避')
            rules_hit.append('G028')
    # 用户避用字
    for h in chars:
        if h['char'] in req.avoid_chars:
            rejects.append('命中用户避用字：%s' % h['char'])
            rules_hit.append('G011')
    # 谐音词（用户反馈：昭黛 → 招待；以及各类贬义谐音）
    hp_hits = hp_hits if hp_hits is not None else homophone_hits(kb, req, given)
    for h in hp_hits:
        if h['kind'] == 'negative' and h['level'] == 'exact':
            rejects.append('谐音不吉：整名读起来像「%s」（%s）' % (h['word'], h['note']))
            rules_hit.append('G029')
        elif h['kind'] == 'negative':
            warns.append('谐音风险：读音接近「%s」，读音仅声调不同，建议换字' % h['word'])
            penalty += 14.0
            rules_hit.append('G029')
        elif h['level'] == 'exact':
            warns.append('谐音联想：整名读起来像常用词「%s」，已优先避开' % h['word'])
            penalty += 10.0
            rules_hit.append('G030')
        else:
            warns.append('谐音联想：读音接近常用词「%s」（仅声调不同）' % h['word'])
            penalty += 5.0
            rules_hit.append('G030')
    return bool(rejects), rejects, warns, sorted(set(rules_hit)), penalty


# ---------------------------------------------------------------- 评分
def _imagery_cat(v):
    """把文化意象字段归入大类，用于判断组合是否意象堆叠。"""
    if not v:
        return ''
    v = str(v)
    table = [('水', ('水', '泽', '江', '河', '湖', '海', '川', '雨', '露', '霜', '雪', '霖', '溪')),
             ('天文', ('天', '云', '月', '星', '辰', '风', '光', '日', '曦', '晖', '曜', '霄', '明光', '虹', '霞', '霓')),
             ('植物', ('植物', '木', '艹', '竹', '兰', '梅', '菊', '荷', '松', '香草')),
             ('动物', ('动物', '鸟', '鹤', '鹏', '鸿')),
             ('山水', ('山', '岳', '峰', '峻')),
             ('玉石器物', ('玉', '石', '器物', '礼', '空间')),
             ('德性', ('德', '修身', '信', '孝', '品格', '坤', '乾', '艮', '志', '远', '进取', '学', '思', '文')),
             ('安和', ('安', '宁', '和', '定', '静', '淡', '素', '玄')),
             ('生长', ('生', '新', '初', '春', '成长', '光明/兴盛')),
             ('家族', ('家', '族', '承')),
             ('智慧', ('智',)),
             ('时序', ('时序',))]
    for cat, keys in table:
        for k in keys:
            if k in v:
                return cat
    return v


def _template_penalty(chars):
    """高频字互相堆叠（如 子涵/梓萱 类模板感）时降低独特性。"""
    hot = {'涵', '轩', '萱', '梓', '子', '欣', '怡', '雨', '语', '思', '佳', '嘉', '怡', '晨', '宸'}
    n = sum(1 for h in chars if h['char'] in hot)
    return 1.0 if n == 0 else (0.75 if n == 1 else 0.45)


_TOKEN_SPLIT = re.compile(r'[、,，/／;；\s]+')
_TOKEN_CACHE = {}
_DEMAND_CACHE = {}      # (char_id, 标签文本...) → 需求匹配分，见 _demand_match


def _tokens(text):
    """拆分标签侧文本并缓存。

    同一个请求里 tag_text/tag_imagery/tag_sem 是常量，却被每个候选字的每个字段反复
    重新 split（实测 8.7 万次 re.split，占了大头）。这里按文本缓存一次即可。
    """
    if not text:
        return ()
    t = _TOKEN_CACHE.get(text)
    if t is None:
        t = tuple(x for x in _TOKEN_SPLIT.split(text) if x and x not in ('不适用', '—', '-'))
        if len(_TOKEN_CACHE) > 4000:      # 简单封顶，避免长期运行无限增长
            _TOKEN_CACHE.clear()
        _TOKEN_CACHE[text] = t
    return t


def _token_overlap(text, target):
    """把标签侧的词与候选字侧的描述做双向包含匹配，返回 0~1。"""
    if not text or not target:
        return 0.0
    toks = _tokens(text)
    if not toks:
        return 0.0
    hit = 0.0
    for t in toks:
        if t in target:
            hit += 1.0
            continue
        for ch in t:
            if ch in target:
                hit += 0.6
                break
    return min(1.0, hit / len(toks))


def _demand_match(chars, kb, tag_text, tag_imagery, tag_sem, tag_classic=''):
    """
    需求匹配度：候选字的描述 / 语义名 / 意象 / 人格语义 与 标签侧 的匹配，
    取"整名层面"与"逐字层面"的加权，避免长描述把分数稀释成噪声。
    """
    def match_one(h):
        # 同一个字会在成百上千个组合里被反复评分，而它的匹配结果只取决于
        # （字 + 本请求的标签文本），因此按这两者缓存。纯函数，缓存不改结果。
        ck = (id(kb), h['char_id'], tag_text, tag_imagery, tag_sem, tag_classic)
        cached = _DEMAND_CACHE.get(ck)
        if cached is not None:
            return cached
        own = '、'.join(filter(None, [
            h['persona_semantic'], h['culture_imagery'], h['modern_meaning']]))
        sem_names = '、'.join(filter(None, [
            (kb.semantic.get(c['semantic_id']) or {}).get('name', '')
            for c in kb.char_semantics.get(h['char_id'], [])]))
        own2 = own + '、' + sem_names
        cands = [
            _token_overlap(tag_text, own2),
            _token_overlap(tag_imagery, own2),
            _token_overlap(tag_sem, own2),
            _token_overlap(tag_text, own),
            _token_overlap(tag_sem, own),
        ]
        if tag_classic:
            # 用标签的优先典籍与候选字出处做匹配
            own_cls = ''
            for c2 in kb.char_semantics.get(h['char_id'], []):
                if c2.get('text_id'):
                    t = kb.texts.get(c2['text_id'])
                    if t:
                        cl = kb.classics.get(t['classic_id'])
                        if cl:
                            own_cls += cl['name'] + '、'
            h_ref = h['source_ref'] or ''
            cands.append(_token_overlap(tag_classic, own_cls))
            cands.append(_token_overlap(tag_classic, h_ref))
        r = max(cands)
        if len(_DEMAND_CACHE) > 60000:
            _DEMAND_CACHE.clear()
        _DEMAND_CACHE[ck] = r
        return r
    per = [match_one(h) for h in chars]
    whole = max(per) if per else 0.0
    avg = sum(per) / len(per) if per else 0.0
    both = 1.0 if all(p > 0 for p in per) else 0.0
    raw = 0.45 * whole + 0.35 * avg + 0.20 * both
    # 没有任何命中时给低基线而非中位数，避免"无关名字也拿 50 分"
    if raw <= 0:
        return 0.12
    return min(1.0, 0.25 + 0.75 * raw)


def score_candidate(kb, req, given, chars, principle_hits, goal_tags, fact_id_set=None,
                    avoid_cues=None):
    detail = {}
    notes = []
    fact_id_set = fact_id_set or set()
    avoid_cues = avoid_cues or set()
    # S01 文化证据度
    ev_num = {'A': 1.0, 'B': 0.6, 'C': 0.25}
    ev_scores = []
    verified_cnt = 0
    for h in chars:
        ev_scores.append(ev_num.get(h['evidence_code'], 0.25))
        if h['citation_status'] == 'verified' and h['citation']:
            verified_cnt += 1
    base_ev = sum(ev_scores) / len(ev_scores) if ev_scores else 0.25
    cov = verified_cnt / len(chars) if chars else 0
    # 出处是否来自不同典籍：多源比同源更具解释厚度
    srcs = set()
    for h in chars:
        for c in kb.char_semantics.get(h['char_id'], []):
            if c.get('text_id'):
                srcs.add(c['text_id'])
    multi_src = 1.0 if len(srcs) >= 2 else 0.0
    detail['S01'] = round(100 * min(1.0, 0.52 * base_ev + 0.34 * cov + 0.14 * multi_src), 1)
    if verified_cnt == len(chars):
        notes.append('两个字都有可核验原文出处')
    elif verified_cnt == 0:
        notes.append('本组合暂无逐条核验的原文出处，出处文化语境')

    # S02 需求匹配度
    tag_text = ''
    tag_imagery = ''
    tag_sem = ''
    tag_classic = ''
    for tid in goal_tags:
        t = kb.tags.get(tid)
        if not t:
            continue
        tag_text += (t['semantic_map'] or '') + '、'
        tag_imagery += (t['imagery_hint'] or '') + '、'
        tag_sem += (t['user_phrase'] or '') + '、'
        tag_classic += (t['classic_hint'] or '') + '、'
    s2 = _demand_match(chars, kb, tag_text, tag_imagery, tag_sem, tag_classic)
    # 用户没有表达需求时该维度不适用：不参与加权，避免所有候选被同一个低分压平
    detail['S02'] = round(100 * s2, 1) if goal_tags else None

    # S08 性别倾向契合度：选了"偏女性"却给出中性/偏男性名字是明确的产品缺陷
    g_scores = [char_gender_score(h, req.gender) for h in chars]
    detail['S08'] = round(100 * (sum(g_scores) / len(g_scores)), 1)

    # S09 命名依据（信）契合度：用户填写的可核验事实有没有真正落到字上
    f_scores = []
    for h in chars:
        m = kb.char_fact.get(h['char_id']) or {}
        f_scores.append(max((_FACT_W.get(v, 0.4) for k, v in m.items() if k in fact_id_set), default=0.0))
    if fact_id_set:
        detail['S09'] = round(100 * (sum(f_scores) / len(f_scores)), 1)
    else:
        detail['S09'] = None

    # S03 音律
    spy, stone = SURNAME_PY.get(req.surname, (None, None))
    tones = [stone] + [h['tone'] for h in chars]
    t_score = score_tone_sequence(tones)
    f_score, f_notes = score_phonetic_flow(spy, chars[0]['pinyin'], chars[1]['pinyin'] if len(chars) > 1 else '')
    detail['S03'] = round(100 * (0.6 * t_score + 0.4 * f_score), 1)
    notes.extend(f_notes)
    if stone:
        notes.append('声调：%s%s' % (req.surname, ''.join(tone_name(t) for t in tones[1:] if t)))

    # S04 字形
    g_score, g_notes = score_glyph([h['strokes'] for h in chars],
                                   [h['structure'] for h in chars],
                                   [h['rare_code'] for h in chars])
    detail['S04'] = round(100 * g_score, 1)
    notes.extend(g_notes)

    # S05 现代适配度
    cm = {'高': 1.0, '中': 0.75, '低': 0.45}
    s5 = sum(cm.get(h['commonness_code'], 0.6) for h in chars) / len(chars)
    hr = {'低': 1.0, '中': 0.7, '高': 0.2}
    s5 = 0.5 * s5 + 0.5 * (sum(hr.get(h['homophone_risk_code'], 0.8) for h in chars) / len(chars))
    detail['S05'] = round(100 * s5, 1)

    # ---------- S06 组合互补度：两字语义角色互补、不重复堆叠 ----------
    if len(chars) < 2:
        # 单字名没有"组合"可言，给中性分，不让它凭空占优或吃亏
        detail['S06'] = 70.0
        notes.append('单字名：无组合互补维度，评分按中性处理')
    else:
        role_terms = []
        for h in chars:
            terms = set()
            for tok in re.split(r'[、,，/／;；\s]+', (h['persona_semantic'] or '') + '、' + (h['culture_imagery'] or '')):
                if tok:
                    terms.add(tok)
            role_terms.append(terms)
        sim = 0.0
        if role_terms[0] and role_terms[1]:
            inter = len(role_terms[0] & role_terms[1])
            sim = inter / min(len(role_terms[0]), len(role_terms[1]))
        t1 = {c['text_id'] for c in kb.char_semantics.get(chars[0]['char_id'], []) if c['text_id']}
        t2 = {c['text_id'] for c in kb.char_semantics.get(chars[1]['char_id'], []) if c['text_id']}
        src_overlap = 1.0 if (t1 and t2 and (t1 & t2)) else 0.0
        cat1, cat2 = _imagery_cat(chars[0]['culture_imagery']), _imagery_cat(chars[1]['culture_imagery'])
        same_cat = bool(cat1) and cat1 == cat2
        # 抽象品格 × 具体意象 的虚实搭配
        abstract_kw = ('德', '修身', '品格', '志', '进取', '学', '思', '文', '安', '宁', '和')
        concrete_kw = ('水', '植物', '动物', '山', '玉', '器物', '天文', '光', '雨', '雪')
        a_abs = any(k in str(chars[0]['culture_imagery']) for k in abstract_kw)
        a_con = any(k in str(chars[0]['culture_imagery']) for k in concrete_kw)
        b_abs = any(k in str(chars[1]['culture_imagery']) for k in abstract_kw)
        b_con = any(k in str(chars[1]['culture_imagery']) for k in concrete_kw)
        mix = (a_abs and b_con) or (a_con and b_abs)
        s6 = 0.72
        s6 += 0.22 * (1.0 - sim)          # 语义角色不重合
        s6 += 0.10 * (1.0 - src_overlap)  # 不同源，避免同句堆叠
        if same_cat:
            s6 -= 0.18
        elif cat1 and cat2:
            s6 += 0.12                    # 跨意象大类
        else:
            s6 -= 0.06                    # 意象类别不明确，信息量偏低
        if mix:
            s6 += 0.08                    # 虚实结合
        detail['S06'] = round(100 * max(0.0, min(1.0, s6)), 1)
        if sim >= 0.8:
            notes.append('两字语义高度重合，寓意层次偏单薄')
        elif src_overlap and detail['S06'] < 60:
            notes.append('两字语义同出一句，属于同源堆叠，建议换掉一个字')
        elif same_cat:
            notes.append('两字意象同属“%s”一类，层次略单' % cat1)
        elif detail['S06'] >= 85:
            notes.append('两字语义跨类互补（%s × %s），层次分明' % (cat1, cat2))

    # S07 独特性（探索维度）
    uniq = sum({'高': 0.35, '中': 0.85, '低': 1.0}.get(h['commonness_code'], 0.6) for h in chars) / len(chars)
    detail['S07'] = round(100 * uniq * _template_penalty(chars), 1)

    # S10 借物契合度：'假'类要求借用户指定的外物取义
    if req.borrow_words:
        b_raw = [char_borrow_score(h, req.borrow_words) for h in chars]
        strongest = max(b_raw) if b_raw else 0.0
        n_hit = sum(1 for x in b_raw if x > 0)
        if strongest >= 2.0:
            detail['S10'] = 100.0 if n_hit >= 2 else 92.0      # 直接用到那样东西
        elif strongest >= 1.0:
            detail['S10'] = 100.0 if n_hit >= 2 else 78.0      # 取该物的文化含义
        else:
            detail['S10'] = 0.0
        if chars and n_hit == 0:
            notes.append('本组合未落到指定的外物（%s）上' % '、'.join(req.borrow_words))
        elif n_hit:
            notes.append('借“%s”之义由“%s”承载' % (
                '、'.join(req.borrow_words),
                '、'.join(h['char'] for h, x in zip(chars, b_raw) if x > 0)))
    else:
        detail['S10'] = None

    # S11 目标契合度：候选是否与用户所选目标一致（冲突字降权、贴切字加分）
    if goal_tags:
        prof, _, glabels = goal_affinity(kb, goal_tags)
        conf = [char_conflicts(h, avoid_cues) for h in chars]
        n_conf = sum(1 for c in conf if c)
        hit = 0
        for h in chars:
            own = (h['persona_semantic'] or '') + (h['culture_imagery'] or '') + (h['modern_meaning'] or '')
            if any(c and c in own for c in prof):
                hit += 1
        detail['S11'] = max(0.0, round(100.0 * hit / len(chars) - 45.0 * n_conf, 1)) if chars else 0.0
        detail['S11_conflict'] = 1 if n_conf else 0
        if n_conf:
            hit_ch = [h['char'] for h, c in zip(chars, conf) if c]
            notes.append('“%s”与你选的目标（%s）气质不符，已降权' % (
                '、'.join(hit_ch), '、'.join(glabels)))
        elif hit == 0:
            notes.append('该组合未直接命中你选的目标（%s）的语义方向' % '、'.join(glabels))
    else:
        detail['S11'] = None

    # 加权总分（core 维度 + 按需启用的专项维度）
    total = 0.0
    wsum = 0.0
    for d in kb.dims:
        if d['scope'] != 'core':
            continue
        v = detail.get(d['dim_id'])
        if v is None:
            continue
        total += v * d['weight']
        wsum += d['weight']
    extra = []
    if req.gender and req.gender != '中性':
        extra.append(('S08', 0.18))      # 用户显式选了性别倾向，就该有足够话语权
    if detail.get('S09') is not None:
        extra.append(('S09', 0.20))      # 用户填了出生事实，"依据是否落到实处"是主要指标
    if detail.get('S10') is not None:
        extra.append(('S10', 0.30))      # 用户选了"假"，借物是否落到实处是主要指标
    for k, w in extra:
        total += detail.get(k, 0) * w
        wsum += w
    score = total / wsum if wsum else 0
    # 目标契合度作为乘数：用户明确写了目标，气质不符就不该排在前面
    if detail.get('S11') is not None:
        s11 = detail['S11']
        if detail.get('S11_conflict'):
            score *= 0.45          # 有明确冲突字
        elif s11 <= 0:
            score *= 0.72          # 没有字命中目标语义
        elif s11 >= 60:
            score *= 1.06          # 贴合目标，略加
    return round(score, 1), detail, notes


def score_components(kb, detail):
    """把分项得分还原成 0~1 供解释展示；未启用的维度返回 None。"""
    out = {}
    for d in kb.dims:
        v = detail.get(d['dim_id'])
        out[d['dimension']] = None if v is None else round(v / 100.0, 2)
    return out


# ---------------------------------------------------------------- 解释
def build_explanation(kb, req, given, chars, principle_hits, evidence, detail, warns,
                      fact_hits=None, borrow_hits=None, notices=None):
    pid_names = '、'.join('%s（%s）' % (kb.principles[p]['name'], kb.principles[p]['rule_meaning'])
                        for p, _, _ in principle_hits)
    lines = []
    lines.append('【取名思路】姓氏“%s”，名“%s”。本名以《左传·桓公六年》五类命名原则为主线：%s。'
                 % (req.surname, given, pid_names))
    # 「信」类：把用户填写的事实与命中的字直接对上
    if fact_hits:
        seg = []
        for fid, label, kind, kw, ids in fact_hits:
            chars_hit = [h['char'] for h in chars if fid in (kb.char_fact.get(h['char_id']) or {})]
            if chars_hit:
                seg.append('“%s”属%s（%s），已落在“%s”字上' % (req.birth_facts, kind, label, '、'.join(chars_hit)))
            else:
                seg.append('“%s”属%s（%s），本名取其%s意境' % (req.birth_facts, kind, label, label))
        lines.append('【命名依据·信】你提供的事实：' + '；'.join(seg)
                     + '。这是《左传》所说“以名生为信”——以可核验的出生事实作为命名依据。')
    # 「假」类：借物是否落到字上
    if req.borrow_words:
        hits = [h['char'] for h in chars if char_borrow_score(h, req.borrow_words) > 0]
        lines.append('【命名依据·假】你希望借“%s”取义，命中字：%s。'
                     % ('、'.join(req.borrow_words), '、'.join(hits) if hits else '本组合未直接落到该物，建议更换指定外物'))
    # 逐字
    for h in chars:
        cites, conflicts = kb.best_citation(h['char_id'])
        pdefs = kb.char_principle.get(h['char_id'], [])
        pids = [p for p, _ in pdefs if p in [x[0] for x in principle_hits]]
        pname = '、'.join(kb.principles[p]['name'] for p in pids) if pids else '—'
        basis = next((b for p, b in pdefs if p in pids), None)
        seg = '“%s”（%s，%d画，%s结构）：%s。文化意象为%s，人格语义为%s。' % (
            h['char'], h['pinyin'] or '—', h['strokes'] or 0, h['structure'] or '—',
            h['modern_meaning'] or h['persona_semantic'] or '—',
            h['culture_imagery'] or '—', h['persona_semantic'] or '—')
        if basis:
            seg += '归属“%s”类，依据：%s。' % (pname, basis)
        if cites.get('content'):
            seg += '原文可核：《%s》%s“%s”。' % (
                (cites.get('classic') or '').strip('《》'),
                _norm_chapter(cites.get('chapter'), cites.get('classic')),
                cites['content'])
        elif cites.get('classic'):
            seg += '文化出处：%s（%s级证据；该处原文尚未录入 T02，故不作为逐条引文）。' % (
                cites['classic'], cites.get('level'))
        else:
            seg += '出处属文化约定（%s级证据），未绑定单句原文。' % cites.get('level')
        if conflicts:
            seg += '注：该字亦见于“%s”语境，本名取其%s义。' % (
                conflicts[0]['semantic_name'], h['persona_semantic'] or h['culture_imagery'] or '主流')
        lines.append('· ' + seg)
    # 证据链（与逐字解释使用同一出处判定，保证一致）
    chain_txt = []
    for h in chars:
        cites, _ = kb.best_citation(h['char_id'])
        if cites.get('content'):
            chain_txt.append('%s ← %s · 《%s》%s' % (
                h['char'], cites.get('semantic') or '语义',
                (cites.get('classic') or '').strip('《》'),
                _norm_chapter(cites.get('chapter'), cites.get('classic'))))
        elif cites.get('classic'):
            chain_txt.append('%s ← 文化语境 · %s（原文未录入）' % (h['char'], cites['classic']))
        else:
            chain_txt.append('%s ← 文化约定（%s级证据）' % (h['char'], cites.get('level')))
    if chain_txt:
        lines.append('【证据链】' + '；'.join(chain_txt))
    # 分项
    comp = score_components(kb, detail)
    lines.append('【分项参考】' + '、'.join(
        ('%s %.2f' % (k, v)) if v is not None else ('%s 未启用' % k) for k, v in comp.items()))
    if req.gender and req.gender != '中性':
        lines.append('【性别倾向】按你选择的“%s”评估，本组合性别契合度 %.2f（契合 1.00 / 中性 0.72 / 相反 0.35）。'
                     % (req.gender, (detail.get('S08') or 0) / 100.0))
    if warns:
        lines.append('【提请注意】' + '；'.join(warns))
    if notices:
        lines.append('【约束提示】' + '；'.join(notices))
    lines.append('【边界说明】本结果依《左传》五类原则与可解释的文化语义生成，不作命运、财富、'
                 '疾病等吉凶预测，也不涉及算卦起卦。')
    return '\n'.join(lines)


# ---------------------------------------------------------------- 主流程
def generate(kb, req, return_rejected=False):
    t0 = time.time()
    # 命名依据最多同时选 2 项：两个字承载不了太多意义，选多了各条依据会互相冲淡，
    # 也无法在名字里逐条落地。超限直接报错，不静默忽略（用户明确要求这条约束）。
    picked_p = sorted(set(req.principles or []))
    if len(picked_p) > 2:
        names = '、'.join((kb.principles.get(p, {}).get('name') or p) for p in picked_p)
        return {'ok': False,
                'error': '命名依据最多同时选 2 项，当前选了 %d 项（%s）。'
                         '两个字承载不了太多意义，请保留最贴近的 2 项。' % (len(picked_p), names),
                'notices': [], 'principle_hits': [], 'rejects': {}}
    goal_tags = list(req.goal_tags)
    # 用户自由文本（第三步「期望」）可以推出任意类别的需求；
    # 「象」面板选的意象词只推意象类标签，避免"山岳"顺带推出「仁厚宽和」这类目标。
    parsed = parse_goals(kb, req.raw_input)
    parsed += parse_goals(kb, req.imagery_hint, groups={'G4', 'G4S'})
    for t in parsed:
        if t not in goal_tags:
            goal_tags.append(t)
    principle_hits, mode = match_principles(kb, req)
    fact_hits = match_facts(kb, req.birth_facts) if any(p == 'F01' for p, _, _ in principle_hits) else []
    fact_id_set = {f[0] for f in fact_hits}
    _prof, avoid_cues, goal_labels = goal_affinity(kb, goal_tags)
    prof_cues = set(_prof or [])
    # 提示语里只点名"表达目标"（G3）标签；意象选项另有专门提示，避免两句话混在一起
    g3_labels = [kb.tags[t]['user_phrase'] for t in goal_tags
                 if t in kb.tags and kb.tags[t].get('group_code') == 'G3'
                 and kb.tags[t].get('user_phrase')]
    # 意象线索：用户选「四季」「花木」这类意象时，选出该意象字族，并要求每个候选至少一个字命中
    cue_specs = imagery_specs(kb, req.imagery_hint)
    cue_opts = resolve_imagery_options(kb, req.imagery_hint)
    cue_strict = False
    n_cue = 0
    # 用户硬指定但字库里没有 / 被约束排除的字，必须明确告知，不能静默忽略
    notices = []
    for ch in list(req.fixed_chars) + list(req.generation_char):
        if ch and ch not in kb.char_by_char:
            notices.append('“%s”不在字库中，无法作为保留字/字辈字使用' % ch)
    # 被过滤掉的非汉字（数字/字母/符号）：明确告知，避免"打了却没生效"的静默失败
    for ch in getattr(req, 'fixed_dropped', []):
        notices.append('“%s”不是汉字，已从“必须保留的字”中忽略' % ch)
    for ch in getattr(req, 'avoid_dropped', []):
        notices.append('“%s”不是汉字，已从“避用的字”中忽略' % ch)
    # 单字名 + 保留字：答案唯一（就是那个字本身），不生成候选
    must_chars = set(req.generation_char) | set(req.fixed_chars)
    # 其中真正能落地的部分（在字库里的）。不在库里的字永远不可能出现在候选里，
    # 若拿它去要求"每个候选都包含"，只会让约束整体失败——见下面 1596 行的严格判定。
    must_ok = {c for c in must_chars if c in kb.char_by_char}
    if req.given_len == 1 and must_chars:
        chars = [c for c in must_chars if c in kb.char_by_char]
        unknown = [c for c in must_chars if c not in kb.char_by_char]
        if len(must_chars) > 1:
            return {'ok': False,
                    'error': '单字名只能指定一个保留字/字辈字，当前指定了 %d 个（%s）'
                             % (len(must_chars), '、'.join(sorted(must_chars))),
                    'notices': ['“%s”不在字库中' % c for c in unknown],
                    'principle_hits': principle_hits, 'rejects': {}}
        if unknown:
            return {'ok': False,
                    'error': '指定的字“%s”不在字库中，无法作为保留字使用' % unknown[0],
                    'notices': ['请换一个字，或在“避开/允许生僻字”里调整约束'],
                    'principle_hits': principle_hits, 'rejects': {}}
        ch = sorted(must_chars)[0]
        char = kb.hanzi[kb.char_by_char[ch]]
        given = ch
        hard, rejects, warns, rules_hit, penalty = check_risks(kb, req, given, [char])
        if hard:
            return {'ok': False, 'error': '指定的字“%s”触发硬拦截：%s' % (ch, '；'.join(rejects)),
                    'principle_hits': principle_hits, 'rejects': {}}
        score, detail, notes = score_candidate(kb, req, given, [char], principle_hits,
                                              goal_tags, fact_id_set=fact_id_set)
        it = {'id': None, 'given_name': given, 'full_name': req.surname + given,
              'score': score, 'score_detail': detail, 'chars': [char],
              'principles': [(p, kb.principles[p]['name'], b) for p, b, _ in principle_hits],
              'warns': warns, 'rules_hit': rules_hit, 'notes': notes,
              'explanation': ''}
        it['explanation'] = build_explanation(kb, req, given, [char], principle_hits, None,
                                             detail, warns, fact_hits=fact_hits, notices=notices)
        it['semantics'] = sorted({c['semantic_id'] for c in kb.evidence_chain(char['char_id'])})
        return {'ok': True, 'request': req.to_dict(), 'mode': mode, 'goal_tags': goal_tags,
                'principle_hits': [{'id': p, 'name': kb.principles[p]['name'],
                                    'meaning': kb.principles[p]['rule_meaning'],
                                    'basis': b, 'trigger': w} for p, b, w in principle_hits],
                'facts_matched': [{'id': f[0], 'label': f[1], 'kind': f[2], 'keyword': f[3],
                                   'chars': [kb.hanzi[c]['char'] for c in f[4]]} for f in fact_hits],
                'pool_size': 1, 'reject_stat': {}, 'notices': ['单字名已指定保留字，答案唯一，无需生成候选']
                                             + notices,
                'candidates': [it], 'rejected_count': 0, 'latency_ms': int((time.time() - t0) * 1000),
                'engine_version': ENGINE_VERSION,
                'knowledge_version': kb.meta.get('knowledge_version')}

    pool, reject_stat = select_chars(kb, req, principle_hits, avoid_cues=avoid_cues,
                                     cue_specs=cue_specs, prof_cues=prof_cues)
    if not pool:
        return {'ok': False, 'error': '在当前原则与约束下没有可用字，请放宽生僻度或避用字限制',
                'notices': notices, 'principle_hits': principle_hits, 'rejects': reject_stat}
    pool_chars = {kb.hanzi[c]['char'] for c in pool}
    for ch in list(req.fixed_chars) + list(req.generation_char):
        if ch and ch in kb.char_by_char and ch not in pool_chars:
            notices.append('“%s”被避用字或生僻度等约束排除，未能进入候选' % ch)

    # 组合生成：单字名 + 双字名
    #
    # 注意：pool 的顺序已经承载了业务优先级（必用字 → 借物命中 → 性别契合 → 事实关联 → 风格）。
    # 因此下面只按"必用字 / 借物字"做一次前置，其余保持 pool 顺序，再整体打散；
    # 不要在这里重新构造列表，否则会把 select_chars 算好的优先级丢掉。
    rng = random.Random(req.seed)
    must_set = set(req.fixed_chars)
    if req.generation_char:
        must_set |= set(req.generation_char)
    must_ids = [kb.char_by_char[c] for c in must_set if c in kb.char_by_char]
    borrow_ids = [cid for cid in pool if char_borrow_score(kb.hanzi[cid], req.borrow_words) > 0]
    # 前置组：必用字、借物字（保持各自在 pool 中的顺序）
    front = []
    for cid in must_ids + borrow_ids:
        if cid not in front:
            front.append(cid)
    rest = [cid for cid in pool if cid not in front]

    combos = []
    if req.given_len == 1:
        combos = [(c,) for c in (must_ids or pool[:24])]
    else:
        # 1) 为每个前置字生成足量组合（避免被 600 上限截断）
        for m in front:
            for cid in (front + rest)[:40]:
                if cid != m:
                    combos.append((m, cid))
        # 2) 主体组合
        head = (front + rest)[:26]
        tail = (front + rest)[:40]
        for a in head:
            for b in tail:
                if a != b:
                    combos.append((a, b))
        # 3) 打散主体，但前置字的组合保持在前
        keyed = []
        for cmb in combos:
            priority = 0 if any(g in cmb for g in front) else 1
            keyed.append((priority, rng.random(), cmb))
        keyed.sort(key=lambda x: (x[0], x[1]))
        combos = [c for _, _, c in keyed]
    combos = combos[:600]

    scored, rejected = [], []
    for combo in combos:
        chars = [kb.hanzi[c] for c in combo]
        given = ''.join(h['char'] for h in chars)
        if len(set(given)) < len(given):
            continue
        hp = homophone_hits(kb, req, given)
        hard, rejects, warns, rules_hit, penalty = check_risks(kb, req, given, chars, hp_hits=hp)
        score, detail, notes = score_candidate(kb, req, given, chars, principle_hits, goal_tags,
                                               fact_id_set=fact_id_set, avoid_cues=avoid_cues)
        final = max(0.0, min(100.0, score + penalty * 0.1))
        item = {
            'given_name': given,
            'full_name': req.surname + given,
            'score': final,
            'score_detail': detail,
            'chars': chars,
            'principles': [(p, kb.principles[p]['name'], basis) for p, basis, _ in principle_hits],
            'warns': warns,
            'rules_hit': rules_hit,
            'notes': notes,
            'homophone': hp,
        }
        if hard:
            item['reject_reason'] = rejects
            rejected.append(item)
        else:
            scored.append(item)

    # 排序去重：优先分高 + 首选字不重复度过高；带硬约束（字辈/保留字）的候选优先
    # 硬约束过滤（按"该类别是否真的成立"来决定严格程度）：
    #   · 字辈字 / 保留字 → 所有候选必须包含
    #   · 「假」指定的外物     → 所有候选必须有一个字真的落到该外物上
    #   · 「信」识别出的事实   → 所有候选必须有一个字承载该事实
    #   过滤后候选不足时宁可少给，也不混入与用户要求无关的组合。
    must_chars = set(req.generation_char) | set(req.fixed_chars)
    if req.given_len >= 2:
        if must_ok:
            # 用户硬指定的字（保留字 / 字辈字 / 多个必用字）必须**全部**出现在候选里。
            # 之前用交集判断，指定两个字时只满足一个就算合格——这与"必用"的承诺不符。
            conform = [it for it in scored if must_ok <= {h['char'] for h in it['chars']}]
            if not conform:
                # 严格失败，不静默降级：以前这里写 `if conform: scored = conform`，
                # 一旦必用字凑不出来（例如字辈写了非汉字"1"，或指定了库外的字），
                # conform 为空就整个跳过过滤，结果里根本没有必用字却照常返回。
                return {'ok': False,
                        'error': '无法满足必用字/字辈字（%s）：当前条件下没有候选能包含它，'
                                 '请放宽其他条件或换一个字' % '、'.join(sorted(must_ok)),
                        'notices': notices, 'principle_hits': principle_hits, 'rejects': {}}
            scored = conform
        elif must_chars:
            # 指定的字全都不在字库（如字辈写了数字/字母），同样明确失败而不是照常出结果
            return {'ok': False,
                    'error': '指定的字（%s）都不在字库中，无法作为保留字/字辈字使用'
                             % '、'.join(sorted(must_chars)),
                    'notices': notices, 'principle_hits': principle_hits, 'rejects': {}}
        if req.borrow_words:
            bconform = [it for it in scored
                        if any(char_borrow_score(h, req.borrow_words) > 0 for h in it['chars'])]
            if bconform:
                scored = bconform
        if fact_id_set:
            fconform = [it for it in scored
                        if any(fact_id_set & set((kb.char_fact.get(h['char_id']) or {}).keys())
                               for h in it['chars'])]
            if fconform:
                scored = fconform
    # 用户显式选了性别倾向时，要求至少一个字与该倾向契合（避免"选了女性却给出中性名"）
    # 字库里契合字很少时放宽为 1 个，并把中性字排在相反倾向之前
    if req.gender in ('男', '偏男性', '女', '偏女性'):
        want = '偏女性' if req.gender in ('女', '偏女性') else '偏男性'
        n_want = sum(1 for h in kb.hanzi.values() if h['gender_bias'] == want)
        need = 2 if n_want >= 6 else 1
        gconform = [it for it in scored if any(h['gender_bias'] == want for h in it['chars'])]
        if len(gconform) >= need:
            scored = gconform
        else:
            gconform2 = [it for it in scored
                         if not any(h['gender_bias'] and h['gender_bias'] != want
                                    and h['gender_bias'] != '中性' for h in it['chars'])]
            if len(gconform2) >= need:
                scored = gconform2
    # 意象契合：选了意象就要求候选字真的落在该意象字族里。
    # 字族够宽（≥12 字）且没有必用字时，要求两个字都取自该字族——用户反馈过
    # "选了四季却给出江流/玉石/植物"，只要求一个字仍然会有一半名字跑题。
    # 字族较窄时退化为"至少一个字命中"，并明确告知，而不是假装贴合。
    if cue_specs:
        n_cue = cue_pool_size(kb, cue_specs, pool)
        aff_cache = {}
        anyc = [it for it in scored
                if any(affinity_cached(h, cue_specs, aff_cache) > 0 for h in it['chars'])]
        both = [it for it in scored
                if all(affinity_cached(h, cue_specs, aff_cache) > 0 for h in it['chars'])]
        if not must_chars and n_cue >= 6 and len(both) >= min(3, req.top_n):
            scored = both
            cue_strict = True
            notices.append('已按意象「%s」选字：两个字都取自该意象字族（可用 %d 个字）'
                           % ('、'.join(cue_opts), n_cue))
        elif len(anyc) >= min(3, req.top_n):
            scored = anyc
            notices.append('已按意象「%s」优先选字：每个名字至少一个字取自该意象字族（可用 %d 个字）'
                           % ('、'.join(cue_opts), n_cue))
        else:
            notices.append('意象「%s」在字库里可用字较少（%d 个），已尽量贴近；'
                           '若想更贴切，可放宽「避开用字」或换一个意象'
                           % ('、'.join(cue_opts), n_cue))
    # 谐音联想：读起来像常用词的候选（如 昭黛 → 招待）在还有别的选择时直接不用。
    # 贬义谐音已在 check_risks 里硬淘汰，这里处理"不贬但会读成词"的那一类。
    if scored and any(it.get('homophone') for it in scored):
        clean = [it for it in scored if not it.get('homophone')]
        if len(clean) >= min(3, req.top_n):
            scored = clean
            notices.append('已避开读起来像常用词的组合（如「招待」这类谐音）')
    # 表达目标（义）与文字的关联：选了目标就要求每个候选至少一个字命中该目标的贴切线索，
    # 否则"选了什么目标"对结果几乎没有影响（用户反馈过这一点）。
    if prof_cues and g3_labels:
        gconform = [it for it in scored
                    if any(char_profile_hit(h, prof_cues) for h in it['chars'])]
        if len(gconform) >= min(3, req.top_n):
            scored = gconform
            notices.append('已按表达目标「%s」选字：每个名字至少一个字贴合该目标'
                           % '、'.join(g3_labels))
    scored.sort(key=lambda x: (-(1 if must_chars & {h['char'] for h in x['chars']} else 0), -x['score']))
    # 多样性选择：最高分先入榜，其余名额按"用到的新字比例"加权挑选，
    # 使同一批候选之间尽量不重复用字（diversity=0 则退化为纯按分数取前 N）
    div = max(0.0, min(1.0, getattr(req, 'diversity', 0.6)))

    def novelty(it, used):
        chars = [h['char'] for h in it['chars']]
        return sum(1 for c in chars if used.get(c, 0) == 0) / len(chars)

    picked, seen_names, used = [], set(), defaultdict(int)
    seen_pairs = set()          # 两个字（无序）是否已被用过，避免「静沅 / 沅静」这类颠倒重复
    remaining = list(scored)
    # 同一个字不允许在整批候选里反复出现（用户没特别要求时）。
    # 字池本身很窄（可用字少）时放宽，否则会出现"给不出候选"。
    # 注意：默认上限就是 1 —— 用户反馈过"静字出现过多"和"整批都带鹏"。
    cap = 1 if len(pool) >= 3 * req.top_n else 2
    if len(pool) < 2 * req.top_n:
        cap = 3
    # 字族窄（如「良马」只有 6 个可用字）时严格按字族选字会凑不满候选，
    # 这里只在"两字都在族内"模式下放宽到 2 次：宁可族内字复现，也不混入跑题的字。
    if cue_strict and n_cue and n_cue < 3 * req.top_n:
        cap = max(cap, 2)
    notice_pool = None
    while remaining and len(picked) < req.top_n:
        best_i, best_key = None, None
        for i, it in enumerate(remaining):
            if it['given_name'] in seen_names:
                continue
            chs = [h['char'] for h in it['chars']]
            # 已达占用上限的字，不再参与新候选（必用字除外——那是用户硬指定）
            if any(used[c] >= cap and c not in must_chars for c in chs):
                continue
            # 两个字相同、只是顺序不同，视为同一个名字（用户明确反馈过这种重复）
            if len(chs) == 2 and chs[0] != chs[1] and frozenset(chs) in seen_pairs:
                continue
            key = it['score'] * (1.0 - div) + 100.0 * novelty(it, used) * div
            if best_key is None or key > best_key:
                best_key, best_i = key, i
        if best_i is None:
            break
        it = remaining.pop(best_i)
        seen_names.add(it['given_name'])
        if len(it['chars']) == 2 and it['chars'][0]['char'] != it['chars'][1]['char']:
            seen_pairs.add(frozenset(h['char'] for h in it['chars']))
        picked.append(it)
        for h in it['chars']:
            used[h['char']] += 1
    if len(picked) < req.top_n:
        # 候选不足：放宽占用上限补足，但要明确告知用户为什么
        if len(pool) < 2 * req.top_n:
            notice_pool = ('可用字较少（%d 字），候选之间难免出现重复用字' % len(pool))
        for it in sorted(remaining, key=lambda x: -x['score']):
            if it['given_name'] in seen_names:
                continue
            seen_names.add(it['given_name'])
            picked.append(it)
            if len(picked) >= req.top_n:
                break
    if notice_pool:
        notices.append(notice_pool)

    for it in picked:
        it['explanation'] = build_explanation(kb, req, it['given_name'], it['chars'],
                                             principle_hits, None, it['score_detail'], it['warns'],
                                             fact_hits=fact_hits, notices=notices)
        it['semantics'] = sorted({c['semantic_id'] for h in it['chars']
                                  for c in kb.evidence_chain(h['char_id'])})
    latency = int((time.time() - t0) * 1000)
    result = {
        'ok': True,
        'request': req.to_dict(),
        'mode': mode,
        'goal_tags': goal_tags,
        'principle_hits': [{'id': p, 'name': kb.principles[p]['name'],
                            'meaning': kb.principles[p]['rule_meaning'],
                            'basis': basis, 'trigger': why} for p, basis, why in principle_hits],
        'facts_matched': [{'id': f[0], 'label': f[1], 'kind': f[2], 'keyword': f[3],
                           'chars': [kb.hanzi[c]['char'] for c in f[4]]} for f in fact_hits],
        'pool_size': len(pool),
        'reject_stat': reject_stat,
        'notices': notices,
        'candidates': picked,
        'rejected_count': len(rejected),
        'latency_ms': latency,
        'engine_version': ENGINE_VERSION,
        'knowledge_version': kb.meta.get('knowledge_version'),
        # 给人看的版本号（与 Excel 版本一致，如 1.27）；knowledge_version 是内部结构版本，
        # 自 V1.14 起不变，直接显示会让人误以为知识库一直没更新。
        'kb_version': kb.meta.get('kb_version'),
    }
    if return_rejected:
        result['rejected'] = rejected[:10]
    return result


# ---------------------------------------------------------------- CLI
def _cli():
    import argparse
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    ap = argparse.ArgumentParser(description='观古定名引擎（左传五类原则）')
    ap.add_argument('--surname', '-s', default='林')
    ap.add_argument('--text', '-t', default='', help='自由需求描述，如"希望孩子聪慧好学、性格温润"')
    ap.add_argument('--tags', default='', help='需求标签ID，逗号分隔，如 U131,U130')
    ap.add_argument('--styles', default='', help='风格偏好，逗号分隔，如 清雅,温润')
    ap.add_argument('--principles', default='', help='指定五类原则，如 F02,F03')
    ap.add_argument('--len', dest='given_len', type=int, default=2)
    ap.add_argument('--gender', default='中性')
    ap.add_argument('--birth', default='', help='信：出生时令或纪念事件')
    ap.add_argument('--generation', default='', help='类：字辈/家族传承字')
    ap.add_argument('--fixed', default='', help='硬约束保留字')
    ap.add_argument('--avoid', default='', help='避用字')
    ap.add_argument('--allow-rare', action='store_true')
    ap.add_argument('--top', type=int, default=5)
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--db', default=DEFAULT_DB)
    a = ap.parse_args()

    kb = KnowledgeBase(a.db)
    req = NamingRequest(
        surname=a.surname, given_len=a.given_len, gender=a.gender,
        goal_tags=[x.strip() for x in a.tags.split(',') if x.strip()],
        styles=[x.strip() for x in a.styles.split(',') if x.strip()],
        principles=[x.strip() for x in a.principles.split(',') if x.strip()],
        birth_facts=a.birth, generation_char=a.generation,
        fixed_chars=a.fixed, avoid_chars=a.avoid,
        allow_rare=a.allow_rare, seed=a.seed, top_n=a.top, raw_input=a.text)
    res = generate(kb, req)
    if a.json:
        out = dict(res)
        for c in out.get('candidates', []):
            c['chars'] = [{k: v for k, v in h.items()} for h in c['chars']]
        print(json.dumps(out, ensure_ascii=False, indent=1, default=str))
        return
    if not res['ok']:
        print('生成失败：', res['error'])
        return
    print('=' * 74)
    print('取名对象：%s  |  模式：%s  |  候选字池：%d 个' % (a.surname + '某', res['mode'], res['pool_size']))
    print('命中五类原则：' + '、'.join('%s-%s' % (p['name'], p['meaning']) for p in res['principle_hits']))
    if res['goal_tags']:
        print('命中需求标签：' + '、'.join(res['goal_tags']))
    print('硬拦截淘汰：%d 个' % res['rejected_count'])
    print('=' * 74)
    for i, c in enumerate(res['candidates'], 1):
        print('\n【%d】%s   综合分 %.1f' % (i, c['full_name'], c['score']))
        print('    分项：' + '  '.join('%s=%s' % (k, ('%.0f' % v) if v is not None else '未启用')
                                    for k, v in c['score_detail'].items()))
        if c['warns']:
            print('    提示：' + '；'.join(c['warns']))
        print('    ' + c['explanation'].replace('\n', '\n    '))
    kb_ver = res.get('kb_version') or res.get('knowledge_version') or '-'
    print('\n耗时 %d ms | 引擎 %s | 知识库 V%s' % (res['latency_ms'], res['engine_version'],
                                              str(kb_ver).lstrip('Vv')))


if __name__ == '__main__':
    _cli()
