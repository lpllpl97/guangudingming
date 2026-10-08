# -*- coding: utf-8 -*-
"""拼音工具：把带声调的拼音拆成"无声调字母 + 声调数字"，用于谐音比对。

放在独立模块里，让 tools/build_db.py 与 engine 共用同一套规则，
避免"建库时一套、运行时另一套"导致谐音查不出来。
"""

TONE_MARKS = {
    'ā': 'a', 'á': 'a', 'ǎ': 'a', 'à': 'a',
    'ē': 'e', 'é': 'e', 'ě': 'e', 'è': 'e',
    'ī': 'i', 'í': 'i', 'ǐ': 'i', 'ì': 'i',
    'ō': 'o', 'ó': 'o', 'ǒ': 'o', 'ò': 'o',
    'ū': 'u', 'ú': 'u', 'ǔ': 'u', 'ù': 'u',
    'ǖ': 'v', 'ǘ': 'v', 'ǚ': 'v', 'ǜ': 'v', 'ü': 'v',
    'ń': 'n', 'ň': 'n', 'ǹ': 'n', 'ḿ': 'm',
}


def toneless(pinyin):
    """去掉声调符号：'zhāo' → 'zhao'"""
    return ''.join(TONE_MARKS.get(c, c) for c in (pinyin or '')).lower()


def key(pinyin, tone=None):
    """无声调字母 + 声调数字：('zhāo', 1) → 'zhao1'；tone 为空则只返回字母。"""
    base = toneless(pinyin)
    return base + (str(tone) if tone else '')


def keys_of(chars, kb_hanzi):
    """把字序列转成 [(toned, toneless)]，字不在字库则返回 None 占位。"""
    out = []
    for ch in chars:
        h = kb_hanzi.get(ch)
        if not h:
            return None
        out.append((key(h['pinyin'], h['tone']), toneless(h['pinyin'])))
    return out


def windows(seq, n):
    """取长度为 n 的所有连续窗口。"""
    return [seq[i:i + n] for i in range(len(seq) - n + 1)]
