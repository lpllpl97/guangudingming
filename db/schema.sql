-- 古典智能取名 · V1.14 规范化数据层（SQLite）
-- 设计原则：
--   1) 拆表：把"一张大宽表 + 多值塞在一个单元格"改成可索引的关系表
--   2) 枚举化：所有程度/等级字段改为受控字典 + 数值权重，规则才能算
--   3) 证据链：char → principle / semantic / imagery / virtue → original_text → classic
--   4) 五类原则：新增 bridge 表，把《左传》五类从"说明文字"变成"可计算归属"

PRAGMA foreign_keys = ON;

-- ============ 字典层 ============
CREATE TABLE dict (
  dict_type   TEXT NOT NULL,          -- 取值域名称
  code        TEXT NOT NULL,          -- 规范编码
  label       TEXT NOT NULL,          -- 中文显示名
  num_value   REAL,                   -- 数值化（如 高=1.0 中=0.6 低=0.3）
  sort_order  INTEGER DEFAULT 0,
  PRIMARY KEY (dict_type, code)
);

-- ============ L1 文化源头层 ============
CREATE TABLE classic (              -- ← T01 古籍元数据
  classic_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  author       TEXT,
  era          TEXT,
  category     TEXT,
  usage_note   TEXT,
  evidence_code TEXT,                -- A/B/C，规范化
  note         TEXT
);

CREATE TABLE original_text (        -- ← T02 古典原文库
  text_id      TEXT PRIMARY KEY,
  classic_id   TEXT NOT NULL REFERENCES classic(classic_id),
  chapter      TEXT,
  content      TEXT NOT NULL,
  paraphrase   TEXT,
  naming_point TEXT,
  evidence_code TEXT,
  source_note  TEXT
);

-- ============ L2 文化知识层 ============
-- 《左传·桓公六年》五类命名原则：本库的主线
CREATE TABLE naming_principle (
  principle_id TEXT PRIMARY KEY,      -- F01..F05
  name         TEXT NOT NULL,         -- 信/义/象/假/类
  original_text TEXT NOT NULL,        -- 以名生为信 ...
  rule_meaning TEXT NOT NULL,
  product_input TEXT,                 -- 产品化输入：需要向用户问什么
  product_rule TEXT,                  -- 产品处理建议
  trigger_field TEXT,                 -- 引擎判定该原则成立所需的字段（机器可读）
  evidence_code TEXT,
  source_ref   TEXT
);

-- 语义单元（原 T06）。原库 D001-D030 与 SEM031-SEM052 并存且 ID 体系混乱，-- 这里统一为 SEM 前缀，原文ID 为可空外键（未核验的置 NULL，不再塞"待核验"字符串）
CREATE TABLE semantic (
  semantic_id  TEXT PRIMARY KEY,
  semantic_type TEXT,
  name         TEXT NOT NULL,
  description  TEXT,
  text_id      TEXT REFERENCES original_text(text_id),
  classic_id   TEXT REFERENCES classic(classic_id),
  locus        TEXT,
  direction    TEXT,                  -- 可用于取名的方向
  evidence_code TEXT,
  note         TEXT,
  verified     INTEGER DEFAULT 0      -- 是否已核验到原文
);

CREATE TABLE imagery (              -- ← T07 文化意象库
  imagery_id   TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT,
  core_meaning TEXT,
  association  TEXT,
  virtue_hint  TEXT,
  source_ref   TEXT,
  evidence_code TEXT,
  style        TEXT,
  dup_group    TEXT,                  -- 去重分组：同组只保留一条首选
  is_primary   INTEGER DEFAULT 1
);

CREATE TABLE virtue (               -- ← T08 品格语义库
  virtue_id    TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  definition   TEXT,
  positive     TEXT,
  imagery_hint TEXT,
  semantic_ref TEXT,
  source_ref   TEXT,
  evidence_code TEXT,
  style        TEXT,
  level        TEXT,                  -- 父级品格 vs 细分品格
  parent_name  TEXT,
  dup_group    TEXT,
  is_primary   INTEGER DEFAULT 1
);

-- ============ L3 语义资产层：汉字库（原 T09，已修复） ============
CREATE TABLE hanzi (
  char_id      TEXT PRIMARY KEY,
  char         TEXT NOT NULL,        -- 单字（修复：剔除混入的词条）
  pinyin       TEXT,
  tone         INTEGER,              -- 1-4 / 0(轻声) / NULL(未定)
  final        TEXT,                 -- 韵母（由带调拼音派生，供韵母相撞检查）
  pinyin_verified INTEGER DEFAULT 0, -- 拼音是否已核验（原库"待核"改为显式标记）
  radical      TEXT,
  strokes      INTEGER,              -- 笔画（新增，字形评分需要）
  structure    TEXT,                 -- 字形结构：左右/上下/独体…（新增）
  modern_meaning TEXT,
  culture_imagery TEXT,
  persona_semantic TEXT,
  style        TEXT,
  gender_bias  TEXT,
  commonness_code TEXT,              -- 人名常用度 高/中/低
  rare_code    TEXT,                 -- 生僻度 低/中/高
  homophone_risk_code TEXT,          -- 谐音风险 低/中/高
  negative_risk_code TEXT,           -- 负面联想风险 低/中/高
  evidence_code TEXT,
  source_ref   TEXT,
  citation     TEXT,                 -- 具体出处（原文级）
  citation_status TEXT,              -- verified / pending / cultural（文化约定，非某句原文）
  UNIQUE(char)
);
CREATE INDEX idx_hanzi_tone ON hanzi(tone);
CREATE INDEX idx_hanzi_style ON hanzi(style);
CREATE INDEX idx_hanzi_final ON hanzi(final);

-- 五类原则的用户向说明：每一类要问用户什么、为什么这么问（前端按此动态展开填写面板）
CREATE TABLE principle_guide (
  principle_id TEXT PRIMARY KEY REFERENCES naming_principle(principle_id),
  user_intro   TEXT,
  user_what    TEXT,
  user_ask     TEXT,
  user_example TEXT,
  why          TEXT,
  panel_title  TEXT,
  panel_note   TEXT,
  no_input     INTEGER DEFAULT 0,
  fields_json  TEXT
);

-- 【关键新增】五类原则 ↔ 汉字 归属桥表：把原则变成可计算字段-- role: 主归属 primary / 兼属 secondary；basis 记录判定依据（可解释、可审计）
CREATE TABLE principle_char (
  principle_id TEXT NOT NULL REFERENCES naming_principle(principle_id),
  char_id      TEXT NOT NULL REFERENCES hanzi(char_id),
  role         TEXT NOT NULL DEFAULT 'primary',
  basis        TEXT,                 -- 归属依据（人工编写，用于向用户解释）
  confidence   TEXT DEFAULT 'B',
  PRIMARY KEY (principle_id, char_id)
);

-- 【关键新增】五类原则 ↔ 语义/意象/品格
CREATE TABLE principle_semantic (
  principle_id TEXT NOT NULL,
  semantic_id  TEXT,
  imagery_id   TEXT,
  virtue_id    TEXT,
  basis        TEXT,
  PRIMARY KEY (principle_id, semantic_id, imagery_id, virtue_id)
);

-- 语义 → 汉字（原 R02，扩到全库）
CREATE TABLE semantic_char (
  semantic_id  TEXT NOT NULL REFERENCES semantic(semantic_id),
  char_id      TEXT NOT NULL REFERENCES hanzi(char_id),
  imagery_id   TEXT,
  virtue_id    TEXT,
  contribution TEXT,
  evidence_code TEXT,
  PRIMARY KEY (semantic_id, char_id)
);

-- 【关键新增】出生事实词库：把'信'类里填写的事实映射到能承载它的字
-- 没有这张表时，"冬天出生"这类输入对选字没有任何影响
CREATE TABLE fact_lexicon (
  fact_id     TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL,        -- 时令 / 天气 / 时辰 / 节气 / 节庆
  keywords    TEXT NOT NULL,        -- 逗号分隔的触发词
  chars       TEXT NOT NULL,        -- 逗号分隔的可承载字
  strong_chars TEXT,                -- 事实直接对应的字（评分更高）
  note        TEXT
);

CREATE TABLE fact_char (
  fact_id  TEXT NOT NULL REFERENCES fact_lexicon(fact_id),
  char_id  TEXT NOT NULL REFERENCES hanzi(char_id),
  strength TEXT NOT NULL DEFAULT 'medium',   -- strong / medium / weak
  PRIMARY KEY (fact_id, char_id)
);

-- ============ L4 产品规则与算法层 ============
-- 统一评分模型（原 T11 存在两套互斥列结构，这里归一）
CREATE TABLE score_dimension (
  dim_id       TEXT PRIMARY KEY,
  dimension    TEXT NOT NULL,
  weight       REAL NOT NULL,        -- 归一化权重，Σ=1.0
  item         TEXT NOT NULL,
  formula      TEXT,
  is_hard_gate INTEGER DEFAULT 0,
  scope        TEXT DEFAULT 'core'   -- core / explore
);

CREATE TABLE rule (                 -- ← T10 规则与风险库（合并同义重复条目）
  rule_id      TEXT PRIMARY KEY,
  rule_type    TEXT NOT NULL,        -- generation/combination/risk/interp/boundary
  name         TEXT NOT NULL,
  condition_expr TEXT,               -- 机器可读条件（引擎按此实现）
  description  TEXT,
  stage        TEXT,
  severity_code TEXT,                -- 高/中/低
  effect       TEXT,                 -- REJECT / REJECT_EXPLANATION / -30 / +10 ...
  effect_value REAL,
  enabled      INTEGER DEFAULT 1,
  status       TEXT,
  note         TEXT,
  supersedes   TEXT                  -- 该条合并了原库哪些重复规则
);

-- 【关键新增】目标标签 ↔ 字义亲和力：让"要求活泼大气"不再给出"淑、静"这类冲突字
CREATE TABLE goal_affinity (
  tag_id  TEXT NOT NULL REFERENCES demand_tag(tag_id),
  kind    TEXT NOT NULL,          -- profile=贴切线索 / avoid=冲突线索
  cue     TEXT NOT NULL,
  PRIMARY KEY (tag_id, kind, cue)
);

-- 【关键新增】《左传》六忌用字：字义本身即为山川/官/国名的字，用于软提示
CREATE TABLE taboo_char (
  char_id  TEXT PRIMARY KEY REFERENCES hanzi(char_id),
  kind     TEXT NOT NULL,     -- 山川 / 官 / 国 / 隐疾 / 畜牲 / 器币
  note     TEXT
);

-- 【关键新增】意象选项 → 字族线索：让"选了四季"真的给出四季相关的字
-- 原实现只把意象当成打分项，选字池完全不受影响，于是出现"选四季却给江流玉石"。
CREATE TABLE imagery_cue (
  cue_id    TEXT PRIMARY KEY,       -- CUE-###
  option    TEXT NOT NULL,          -- 面板选项名，如 四季 / 花木 / 江河湖海
  label     TEXT NOT NULL,          -- 子族名，如 春 / 秋 / 时令物候
  keywords  TEXT,                   -- 逗号分隔，去匹配字条的意象/人格/释义字段
  chars     TEXT,                   -- 人工精挑的明确字表（优先级高于 keywords）
  note      TEXT
);

-- 【关键新增】谐音词表：避免名字读出来像常用词或贬义词（如 昭黛 → 招待）
-- pinyin 为带声调数字的串（zhao1dai4），pinyin_loose 为不带声调串（zhaodai）；
-- 引擎按"整名里任意连续 n 个音节"比对，n = 词的字数。
CREATE TABLE homophone_word (
  word          TEXT PRIMARY KEY,
  pinyin        TEXT NOT NULL,
  pinyin_loose  TEXT NOT NULL,
  syllables     INTEGER NOT NULL,
  kind          TEXT NOT NULL,      -- negative=贬义/不吉 / word=普通常用词
  severity_code TEXT,
  note          TEXT
);

CREATE TABLE risk_lexicon (         -- 新增：风险词典（原库只有规则名，没有词表）
  term      TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,           -- homophone/negative/public_figure/brand/rare/taboo
  severity_code TEXT,
  note      TEXT
);

-- 用户需求标签（原 T12）：补 parent_code，形成 层级→标签 的可选清单
CREATE TABLE demand_tag (
  tag_id       TEXT PRIMARY KEY,
  group_code   TEXT,                 -- 规范化后的分组编码
  group_name   TEXT,                 -- 中文分组名
  user_phrase  TEXT,
  semantic_map TEXT,
  imagery_hint TEXT,
  classic_hint TEXT,
  risk_note    TEXT,
  priority_code TEXT,
  principle_hint TEXT,               -- 【新增】该需求默认倾向哪一类原则
  engine_field TEXT                  -- 【新增】对应引擎输入字段
);

-- 候选名字组合（原 T13，修复字ID悬空与标签悬空）
CREATE TABLE name_case (
  case_id      TEXT PRIMARY KEY,
  surname      TEXT,
  given_name   TEXT,
  combo_type   TEXT,
  core_meaning TEXT,
  culture_ref  TEXT,
  tone_check   TEXT,
  glyph_check  TEXT,
  homophone_risk TEXT,
  modernity    TEXT,
  total_score  REAL,
  level        TEXT,
  explanation  TEXT,
  tag_id       TEXT REFERENCES demand_tag(tag_id),
  char_id_1    TEXT REFERENCES hanzi(char_id),
  char_id_2    TEXT REFERENCES hanzi(char_id),
  rule_ids     TEXT,
  review       TEXT,
  passed       INTEGER,
  iteration_note TEXT,
  char_count   INTEGER                -- 名字字数（由候选名派生，便于按 U122 硬约束筛选）
);

-- ============ 运行时层（原 E01 运行数据模型） ============
CREATE TABLE naming_request (
  request_id   TEXT PRIMARY KEY,
  created_at   TEXT,
  surname      TEXT,
  given_len    INTEGER,
  object_type  TEXT,
  gender       TEXT,
  goals        TEXT,                 -- JSON: 需求标签ID列表
  styles       TEXT,                 -- JSON
  principles   TEXT,                 -- JSON: 用户指定的五类原则（可空=系统推荐）
  birth_facts  TEXT,                 -- 信：出生时令/纪念事件
  generation_char TEXT,              -- 类：字辈
  fixed_chars  TEXT,                 -- 硬约束保留字
  avoid_chars  TEXT,
  allow_rare   INTEGER DEFAULT 0,
  raw_input    TEXT
);

CREATE TABLE naming_candidate (
  candidate_id TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL REFERENCES naming_request(request_id),
  full_name    TEXT NOT NULL,
  given_name   TEXT NOT NULL,
  score        REAL,
  score_detail TEXT,                 -- JSON: 分项得分
  principles   TEXT,                 -- JSON: 命中的五类原则及依据
  semantics    TEXT,                 -- JSON: 语义ID
  evidence     TEXT,                 -- JSON: 证据链（原文ID/出处）
  explanation  TEXT,
  risks        TEXT,                 -- JSON
  rejected     INTEGER DEFAULT 0,
  reject_reason TEXT
);

CREATE TABLE generation_log (
  log_id       TEXT PRIMARY KEY,
  request_id   TEXT,
  engine_version TEXT,
  knowledge_version TEXT,
  latency_ms   INTEGER,
  created_at   TEXT,
  detail       TEXT
);

CREATE TABLE meta_version (
  key   TEXT PRIMARY KEY,
  value TEXT
);
