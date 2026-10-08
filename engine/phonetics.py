# -*- coding: utf-8 -*-
"""音律与字形规则工具（无第三方依赖）。"""

TONE_MAP = str.maketrans({
    'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
    'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
    'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
    'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
    'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
    'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v',
})

# 双字母声母优先匹配
INITIALS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
            'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w']

# 理想声调序列（姓 + 名1 + 名2）：避免三连同调，偏好有起伏
GOOD_TONE_PATTERNS = {
    (2, 4, 3), (2, 4, 2), (2, 3, 2), (2, 2, 4), (2, 1, 4), (2, 4, 1),
    (4, 2, 3), (4, 2, 1), (4, 1, 2), (4, 2, 4), (4, 3, 2), (4, 1, 3),
    (1, 2, 4), (1, 4, 3), (1, 2, 3), (1, 4, 2), (1, 3, 2),
    (3, 2, 4), (3, 4, 2), (3, 2, 1), (3, 1, 4), (3, 4, 1),
    (2, 1, 3), (4, 3, 1), (1, 3, 4),
}


def strip_tone(pinyin):
    if not pinyin:
        return ''
    return pinyin.strip().lower().translate(TONE_MAP)


def initial(pinyin):
    s = strip_tone(pinyin)
    if not s:
        return ''
    for i in INITIALS:
        if s.startswith(i):
            return i
    return s[0]


def same_final(a, b):
    """韵母完全相同（同音相撞）"""
    return bool(a) and a == b


def tone_name(t):
    return {1: '一', 2: '二', 3: '三', 4: '四', 0: '轻'}.get(t, '?')


def score_tone_sequence(tones):
    """
    tones: [姓声调, 名1声调, 名2声调] —— 缺失项以 None 表示。
    返回 0~1 的音律分。
    """
    known = [t for t in tones if t]
    if len(known) < 2:
        return 0.7  # 数据不足，给中性分，不惩罚用户
    score = 0.45
    # 1) 三连同调重罚
    run = 1
    max_run = 1
    for i in range(1, len(known)):
        run = run + 1 if known[i] == known[i - 1] else 1
        max_run = max(max_run, run)
    if max_run >= 3:
        score -= 0.30
    elif max_run == 2:
        score -= 0.05
    # 2) 声调有起伏加分
    if len(set(known)) == len(known):
        score += 0.22
    elif len(set(known)) == 2:
        score += 0.10
    # 3) 落在偏好序列上
    if len(tones) == 3 and all(tones):
        if tuple(tones) in GOOD_TONE_PATTERNS:
            score += 0.18
    # 4) 末字忌同调收尾过平
    if len(known) >= 2 and known[-1] == known[-2]:
        score -= 0.06
    return max(0.0, min(1.0, score))


def score_phonetic_flow(surname_py, py1, py2):
    """声母/韵母层面的流畅度：避免同名同音、声母重复、韵母相撞。"""
    score = 1.0
    notes = []
    i0, i1, i2 = initial(surname_py), initial(py1), initial(py2)
    f1 = strip_tone(py1)[len(i1):]
    f2 = strip_tone(py2)[len(i2):]
    if strip_tone(py1) and strip_tone(py1) == strip_tone(py2):
        score -= 0.5
        notes.append('名字两字同音，读起来重复')
    if i1 and i2 and i1 == i2:
        score -= 0.18
        notes.append('两名字声母相同，音节起头偏重复')
    if same_final(f1, f2):
        score -= 0.20
        notes.append('两名字韵母相同，收尾相撞')
    if i0 and i0 == i1:
        score -= 0.10
        notes.append('姓氏与首字声母相同')
    return max(0.0, score), notes


def score_glyph(strokes, structures, rare_codes):
    """字形可用性：平均笔画适中、结构不重复、无生僻叠加。"""
    score = 1.0
    notes = []
    st = [s for s in strokes if s]
    if st:
        avg = sum(st) / len(st)
        if avg > 17:
            score -= 0.20
            notes.append('笔画偏多（平均 %.0f 画），书写负担较大' % avg)
        elif avg < 5:
            score -= 0.10
            notes.append('笔画偏少（平均 %.0f 画），字形略单薄' % avg)
        spread = max(st) - min(st)
        if len(st) >= 2 and spread >= 14:
            score -= 0.12
            notes.append('名字内部笔画数差异过大，视觉不平衡')
    stc = [s for s in structures if s]
    if len(stc) >= 2 and len(set(stc)) < len(stc):
        score -= 0.15
        notes.append('字形结构重复（如均为左右结构），辨识度偏低')
    if rare_codes.count('高') >= 1:
        score -= 0.25
        notes.append('含高生僻度字')
    return max(0.0, score), notes
