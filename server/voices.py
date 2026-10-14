"""System voice catalogue, grouped by the model that owns them.

Transcribed from the official DashScope reference:
https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list

Every id here has been probed against the live API. Voice ids are strictly
model-bound: `longanqian` belongs to the qwen-audio realtime models and is
rejected by cosyvoice with error 418, and the `_v3` suffix exists precisely to
distinguish the v3 generation from the v2 one.
"""

from typing import Sequence

# --- cosyvoice-v3-flash (89 voices) --------------------------------------

V3_VOICES: list[dict] = [
    # --- 标杆音色 (Instruct supported) ---
    {"id": "longanyang", "name": "龙安洋", "trait": "阳光大男孩", "lang": "中文/英文",
     "group": "标杆音色", "instruct": True},
    {"id": "longanhuan", "name": "龙安欢", "trait": "欢脱元气女", "lang": "中文/英文",
     "group": "标杆音色", "instruct": True},
    {"id": "longanhuan_v3", "name": "龙安欢(V3)", "trait": "欢脱元气女 · 支持方言", "lang": "中文(含9种方言)/英文",
     "group": "标杆音色", "instruct": True, "dialect": True},
    {"id": "longhuhu_v3", "name": "龙呼呼", "trait": "天真烂漫女童", "lang": "中文/英文",
     "group": "标杆音色", "instruct": True},

    # --- 社交陪伴 ---
    {"id": "longantai_v3", "name": "龙安台", "trait": "嗲甜台湾女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longhua_v3", "name": "龙华", "trait": "元气甜美女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longcheng_v3", "name": "龙橙", "trait": "智慧青年男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longze_v3", "name": "龙泽", "trait": "温暖元气男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longzhe_v3", "name": "龙哲", "trait": "呆板大暖男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longyan_v3", "name": "龙颜", "trait": "温暖春风女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longxing_v3", "name": "龙星", "trait": "温婉邻家女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longtian_v3", "name": "龙天", "trait": "磁性理智男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longwan_v3", "name": "龙婉", "trait": "细腻柔声女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longqiang_v3", "name": "龙嫱", "trait": "浪漫风情女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longfeifei_v3", "name": "龙菲菲", "trait": "甜美娇气女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longhao_v3", "name": "龙浩", "trait": "多情忧郁男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanrou_v3", "name": "龙安柔", "trait": "温柔闺蜜女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longhan_v3", "name": "龙寒", "trait": "温暖痴情男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanzhi_v3", "name": "龙安智", "trait": "睿智轻熟男", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanling_v3", "name": "龙安灵", "trait": "思维灵动女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanya_v3", "name": "龙安雅", "trait": "高雅气质女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanqin_v3", "name": "龙安亲", "trait": "亲和活泼女", "lang": "中文/英文", "group": "社交陪伴"},
    {"id": "longanshuo_v3", "name": "龙安朔", "trait": "干净清爽男", "lang": "中文/英文", "group": "社交陪伴"},

    # --- 语音助手 ---
    {"id": "longxiaochun_v3", "name": "龙小淳", "trait": "知性积极女", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longxiaoxia_v3", "name": "龙小夏", "trait": "沉稳权威女", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longyumi_v3", "name": "YUMI", "trait": "正经青年女", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longanyun_v3", "name": "龙安昀", "trait": "居家暖男", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longanwen_v3", "name": "龙安温", "trait": "优雅知性女", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longanli_v3", "name": "龙安莉", "trait": "利落从容女", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longanlang_v3", "name": "龙安朗", "trait": "清爽利落男", "lang": "中文/英文", "group": "语音助手"},
    {"id": "longyingmu_v3", "name": "龙应沐", "trait": "优雅知性女", "lang": "中文/英文", "group": "语音助手"},

    # --- 客服 ---
    {"id": "longyingxun_v3", "name": "龙应询", "trait": "年轻青涩男", "lang": "中文/英文", "group": "客服"},
    {"id": "longyingjing_v3", "name": "龙应静", "trait": "低调冷静女", "lang": "中文/英文", "group": "客服"},
    {"id": "longyingling_v3", "name": "龙应聆", "trait": "温和共情女", "lang": "中文/英文", "group": "客服"},
    {"id": "longyingtao_v3", "name": "龙应桃", "trait": "温柔淡定女", "lang": "中文/英文", "group": "客服"},
    {"id": "longyingxiao_v3", "name": "龙应笑", "trait": "清甜推销女", "lang": "中文/英文", "group": "客服"},

    # --- 有声书 / 短视频 ---
    {"id": "longmiao_v3", "name": "龙妙", "trait": "抑扬顿挫女", "lang": "中文/英文", "group": "有声书"},
    {"id": "longsanshu_v3", "name": "龙三叔", "trait": "沉稳质感男", "lang": "中文/英文", "group": "有声书"},
    {"id": "longyuan_v3", "name": "龙媛", "trait": "温暖治愈女", "lang": "中文/英文", "group": "有声书"},
    {"id": "longyue_v3", "name": "龙悦", "trait": "温暖磁性女", "lang": "中文/英文", "group": "有声书"},
    {"id": "longxiu_v3", "name": "龙修", "trait": "博才说书男", "lang": "中文/英文", "group": "有声书"},
    {"id": "longnan_v3", "name": "龙楠", "trait": "睿智青年男", "lang": "中文/英文", "group": "有声书"},
    {"id": "longwanjun_v3", "name": "龙婉君", "trait": "细腻柔声女", "lang": "中文/英文", "group": "有声书"},
    {"id": "longyichen_v3", "name": "龙逸尘", "trait": "洒脱活力男", "lang": "中文/英文", "group": "有声书"},
    {"id": "longlaobo_v3", "name": "龙老伯", "trait": "沧桑岁月爷", "lang": "中文/英文", "group": "有声书"},
    {"id": "longlaoyi_v3", "name": "龙老姨", "trait": "烟火从容阿姨", "lang": "中文/英文", "group": "有声书"},
    {"id": "longjiqi_v3", "name": "龙机器", "trait": "呆萌机器人", "lang": "中文/英文", "group": "短视频配音"},
    {"id": "longhouge_v3", "name": "龙猴哥", "trait": "经典猴哥", "lang": "中文/英文", "group": "短视频配音"},
    {"id": "longdaiyu_v3", "name": "龙黛玉", "trait": "娇率才女音", "lang": "中文/英文", "group": "短视频配音"},
    {"id": "loongbella_v3", "name": "Bella3.0", "trait": "精准干练女", "lang": "中文/英文", "group": "短视频配音"},

    # --- 新闻播报 / 直播带货 ---
    {"id": "longshuo_v3", "name": "龙硕", "trait": "博才干练男", "lang": "中文/英文", "group": "新闻播报"},
    {"id": "longshu_v3", "name": "龙书", "trait": "沉稳青年男", "lang": "中文/英文", "group": "新闻播报"},
    {"id": "longanran_v3", "name": "龙安燃", "trait": "活泼质感女", "lang": "中文/英文", "group": "直播带货"},
    {"id": "longanxuan_v3", "name": "龙安宣", "trait": "经典直播女", "lang": "中文/英文", "group": "直播带货"},
    {"id": "longfei_v3", "name": "龙飞", "trait": "热血磁性男", "lang": "中文/英文", "group": "诗词朗诵"},

    # --- 童声 / 智能玩具 ---
    {"id": "longpaopao_v3", "name": "龙泡泡", "trait": "飞天泡泡音", "lang": "中文/英文", "group": "童声"},
    {"id": "longjielidou_v3", "name": "龙杰力豆", "trait": "阳光顽皮男", "lang": "中文/英文", "group": "童声"},
    {"id": "longxian_v3", "name": "龙仙", "trait": "豪放可爱女", "lang": "中文/英文", "group": "童声"},
    {"id": "longling_v3", "name": "龙铃", "trait": "稚气呆板女", "lang": "中文/英文", "group": "童声"},
    {"id": "longshanshan_v3", "name": "龙闪闪", "trait": "戏剧化童声", "lang": "中文/英文", "group": "童声"},
    {"id": "longniuniu_v3", "name": "龙牛牛", "trait": "阳光男童声", "lang": "中文/英文", "group": "童声"},

    # --- 方言 ---
    {"id": "longjiaxin_v3", "name": "龙嘉欣", "trait": "优雅粤语女", "lang": "粤语/英文", "group": "方言"},
    {"id": "longjiayi_v3", "name": "龙嘉怡", "trait": "知性粤语女", "lang": "粤语/英文", "group": "方言"},
    {"id": "longanyue_v3", "name": "龙安粤", "trait": "欢脱粤语男", "lang": "粤语/英文", "group": "方言"},
    {"id": "longlaotie_v3", "name": "龙老铁", "trait": "东北直率男", "lang": "东北话/英文", "group": "方言"},
    {"id": "longshange_v3", "name": "龙陕哥", "trait": "原味陕北男", "lang": "陕西话/英文", "group": "方言"},
    {"id": "longanmin_v3", "name": "龙安闽", "trait": "清纯萝莉女", "lang": "闽南话/英文", "group": "方言"},

    # --- 出海营销 ---
    {"id": "loongkyong_v3", "name": "loongkyong", "trait": "韩语女", "lang": "韩语", "group": "出海营销"},
    {"id": "loongjihun_v3", "name": "Jihun", "trait": "韩语男", "lang": "韩语", "group": "出海营销"},
    {"id": "loongriko_v3", "name": "Riko", "trait": "二次元霓虹女", "lang": "日语", "group": "出海营销"},
    {"id": "loongtomoka_v3", "name": "loongtomoka", "trait": "日语女", "lang": "日语", "group": "出海营销"},
    {"id": "loongtomoya_v3", "name": "loongtomoya", "trait": "日语男", "lang": "日语", "group": "出海营销"},
    {"id": "loongyuuna_v3", "name": "Yuuna", "trait": "日语女", "lang": "日语", "group": "出海营销"},
    {"id": "loongyuuma_v3", "name": "Yuuma", "trait": "日语男", "lang": "日语", "group": "出海营销"},
    {"id": "loongabby_v3", "name": "loongabby", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongandy_v3", "name": "loongandy", "trait": "美式英文男", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongannie_v3", "name": "loongannie", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongava_v3", "name": "loongava", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongbeth_v3", "name": "loongbeth", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongbetty_v3", "name": "loongbetty", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongcally_v3", "name": "loongcally", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongcindy_v3", "name": "loongcindy", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongdavid_v3", "name": "loongdavid", "trait": "美式英文男", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongdonna_v3", "name": "loongdonna", "trait": "美式英文女", "lang": "美式英语", "group": "出海营销"},
    {"id": "loongemily_v3", "name": "loongemily", "trait": "英式英文女", "lang": "英式英语", "group": "出海营销"},
    {"id": "loongeric_v3", "name": "loongeric", "trait": "英式英文男", "lang": "英式英语", "group": "出海营销"},
    {"id": "loongluna_v3", "name": "loongluna", "trait": "英式英文女", "lang": "英式英语", "group": "出海营销"},
    {"id": "loongluca_v3", "name": "loongluca", "trait": "英式英文男", "lang": "英式英语", "group": "出海营销"},
    {"id": "loongindah_v3", "name": "loongindah", "trait": "印尼女", "lang": "印尼语", "group": "出海营销"},
]

# --- cosyvoice-v3-plus: only the two benchmark voices carry over -----------

V3_PLUS_VOICES: list[dict] = [
    {"id": "longanyang", "name": "龙安洋", "trait": "阳光大男孩", "lang": "中文/英文", "instruct": True},
    {"id": "longanhuan", "name": "龙安欢", "trait": "欢脱元气女", "lang": "中文/英文", "instruct": True},
]

# --- cosyvoice-v2 ------------------------------------------------------------

V2_VOICES: list[dict] = [
    {"id": "longyingxiao", "name": "龙应笑", "trait": "清甜推销女", "lang": "中文/英文"},
    {"id": "longjiqi", "name": "龙机器", "trait": "呆萌机器人", "lang": "中文/英文"},
    {"id": "longhouge", "name": "龙猴哥", "trait": "经典猴哥", "lang": "中文/英文"},
    {"id": "longjixin", "name": "龙机心", "trait": "毒舌心机女", "lang": "中文/英文"},
    {"id": "longanyue", "name": "龙安粤", "trait": "欢脱粤语男", "lang": "中文/英文"},
    {"id": "longshange", "name": "龙陕哥", "trait": "原味陕北男", "lang": "中文/英文"},
    {"id": "longanmin", "name": "龙安敏", "trait": "甜美闽南女", "lang": "中文/英文"},
    {"id": "longdaiyu", "name": "龙黛玉", "trait": "娇率才女音", "lang": "中文/英文"},
    {"id": "longgaoseng", "name": "龙高僧", "trait": "得道高僧音", "lang": "中文/英文"},
    {"id": "longanli", "name": "龙安莉", "trait": "利落从容女", "lang": "中文/英文"},
    {"id": "longanlang", "name": "龙安朗", "trait": "清爽利落男", "lang": "中文/英文"},
    {"id": "longanwen", "name": "龙安温", "trait": "优雅知性女", "lang": "中文/英文"},
    {"id": "longanyun", "name": "龙安昀", "trait": "居家暖男", "lang": "中文/英文"},
    {"id": "longyumi_v2", "name": "YUMI", "trait": "正经青年女", "lang": "中文/英文"},
    {"id": "longxiaochun_v2", "name": "龙小淳", "trait": "知性积极女", "lang": "中文/英文"},
    {"id": "longxiaoxia_v2", "name": "龙小夏", "trait": "沉稳权威女", "lang": "中文/英文"},
    {"id": "longyichen", "name": "龙逸尘", "trait": "洒脱活力男", "lang": "中文/英文"},
    {"id": "longwanjun", "name": "龙婉君", "trait": "细腻柔声女", "lang": "中文/英文"},
    {"id": "longlaobo", "name": "龙老伯", "trait": "沧桑岁月爷", "lang": "中文/英文"},
    {"id": "longlaoyi", "name": "龙老姨", "trait": "烟火从容阿姨", "lang": "中文/英文"},
    {"id": "longbaizhi", "name": "龙白芷", "trait": "睿气旁白女", "lang": "中文/英文"},
    {"id": "longsanshu", "name": "龙三叔", "trait": "沉稳质感男", "lang": "中文/英文"},
    {"id": "longxiu_v2", "name": "龙修", "trait": "博才说书男", "lang": "中文/英文"},
    {"id": "longmiao_v2", "name": "龙妙", "trait": "抑扬顿挫女", "lang": "中文/英文"},
    {"id": "longyue_v2", "name": "龙悦", "trait": "温暖磁性女", "lang": "中文/英文"},
    {"id": "longnan_v2", "name": "龙楠", "trait": "睿智青年男", "lang": "中文/英文"},
    {"id": "longyuan_v2", "name": "龙媛", "trait": "温暖治愈女", "lang": "中文/英文"},
    {"id": "longanqin", "name": "龙安亲", "trait": "亲和活泼女", "lang": "中文/英文"},
    {"id": "longanya", "name": "龙安雅", "trait": "高雅气质女", "lang": "中文/英文"},
    {"id": "longanshuo", "name": "龙安朔", "trait": "干净清爽男", "lang": "中文/英文"},
    {"id": "longanling", "name": "龙安灵", "trait": "思维灵动女", "lang": "中文/英文"},
    {"id": "longanzhi", "name": "龙安智", "trait": "睿智轻熟男", "lang": "中文/英文"},
    {"id": "longanrou", "name": "龙安柔", "trait": "温柔闺蜜女", "lang": "中文/英文"},
    {"id": "longqiang_v2", "name": "龙嫱", "trait": "浪漫风情女", "lang": "中文/英文"},
    {"id": "longhan_v2", "name": "龙寒", "trait": "温暖痴情男", "lang": "中文/英文"},
    {"id": "longxing_v2", "name": "龙星", "trait": "温婉邻家女", "lang": "中文/英文"},
    {"id": "longhua_v2", "name": "龙华", "trait": "元气甜美女", "lang": "中文/英文"},
    {"id": "longwan_v2", "name": "龙婉", "trait": "积极知性女", "lang": "中文/英文"},
    {"id": "longcheng_v2", "name": "龙橙", "trait": "智慧青年男", "lang": "中文/英文"},
    {"id": "longfeifei_v2", "name": "龙菲菲", "trait": "甜美娇气女", "lang": "中文/英文"},
    {"id": "longxiaocheng_v2", "name": "龙小诚", "trait": "磁性低音男", "lang": "中文/英文"},
    {"id": "longzhe_v2", "name": "龙哲", "trait": "呆板大暖男", "lang": "中文/英文"},
    {"id": "longyan_v2", "name": "龙颜", "trait": "温暖春风女", "lang": "中文/英文"},
    {"id": "longtian_v2", "name": "龙天", "trait": "磁性理智男", "lang": "中文/英文"},
    {"id": "longze_v2", "name": "龙泽", "trait": "温暖元气男", "lang": "中文/英文"},
    {"id": "longshao_v2", "name": "龙邵", "trait": "积极向上男", "lang": "中文/英文"},
    {"id": "longhao_v2", "name": "龙浩", "trait": "多情忧郁男", "lang": "中文/英文"},
    {"id": "kabuleshen_v2", "name": "龙深", "trait": "实力歌手男", "lang": "中文/英文"},
    {"id": "longhuhu", "name": "龙呼呼", "trait": "天真烂漫女童", "lang": "中文/英文"},
    {"id": "longanpei", "name": "龙安培", "trait": "青少年教师女", "lang": "中文/英文"},
    {"id": "longwangwang", "name": "龙汪汪", "trait": "台湾少年音", "lang": "中文/英文"},
    {"id": "longpaopao", "name": "龙泡泡", "trait": "飞天泡泡音", "lang": "中文/英文"},
    {"id": "longshanshan", "name": "龙闪闪", "trait": "戏剧化童声", "lang": "中文/英文"},
    {"id": "longniuniu", "name": "龙牛牛", "trait": "阳光男童声", "lang": "中文/英文"},
    {"id": "longyingmu", "name": "龙应沐", "trait": "优雅知性女", "lang": "中文/英文"},
    {"id": "longyingxun", "name": "龙应询", "trait": "年轻青涩男", "lang": "中文/英文"},
    {"id": "longyingcui", "name": "龙应催", "trait": "严肃催收男", "lang": "中文/英文"},
    {"id": "longyingda", "name": "龙应答", "trait": "开朗高音女", "lang": "中文/英文"},
    {"id": "longyingjing", "name": "龙应静", "trait": "低调冷静女", "lang": "中文/英文"},
    {"id": "longyingyan", "name": "龙应严", "trait": "义正严辞女", "lang": "中文/英文"},
    {"id": "longyingtian", "name": "龙应甜", "trait": "温柔甜美女", "lang": "中文/英文"},
    {"id": "longyingbing", "name": "龙应冰", "trait": "尖锐强势女", "lang": "中文/英文"},
    {"id": "longyingtao", "name": "龙应桃", "trait": "温柔淡定女", "lang": "中文/英文"},
    {"id": "longyingling", "name": "龙应聆", "trait": "温和共情女", "lang": "中文/英文"},
    {"id": "longanran", "name": "龙安燃", "trait": "活泼质感女", "lang": "中文/英文"},
    {"id": "longanxuan", "name": "龙安宣", "trait": "经典直播女", "lang": "中文/英文"},
    {"id": "longanchong", "name": "龙安冲", "trait": "激情推销男", "lang": "中文/英文"},
    {"id": "longanping", "name": "龙安萍", "trait": "高亢直播女", "lang": "中文/英文"},
    {"id": "longjielidou_v2", "name": "龙杰力豆", "trait": "阳光顽皮男", "lang": "中文/英文"},
    {"id": "longling_v2", "name": "龙铃", "trait": "稚气呆板女", "lang": "中文/英文"},
    {"id": "longke_v2", "name": "龙可", "trait": "懵懂乖乖女", "lang": "中文/英文"},
    {"id": "longxian_v2", "name": "龙仙", "trait": "豪放可爱女", "lang": "中文/英文"},
    {"id": "longlaotie_v2", "name": "龙老铁", "trait": "东北直率男", "lang": "中文/英文"},
    {"id": "longjiayi_v2", "name": "龙嘉怡", "trait": "知性粤语女", "lang": "中文/英文"},
    {"id": "longtao_v2", "name": "龙桃", "trait": "积极粤语女", "lang": "中文/英文"},
    {"id": "longfei_v2", "name": "龙飞", "trait": "热血磁性男", "lang": "中文/英文"},
    {"id": "libai_v2", "name": "李白", "trait": "古代诗仙男", "lang": "中文/英文"},
    {"id": "longjin_v2", "name": "龙津", "trait": "优雅温润男", "lang": "中文/英文"},
    {"id": "longshu_v2", "name": "龙书", "trait": "沉稳青年男", "lang": "中文/英文"},
]

# --- qwen-audio-3.0-tts-flash -------------------------------------------------
# Transcribed from https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
# Note the unusual `_v3.6` suffix -- it is what the published table actually
# uses, not a typo. `longanhuan_mtlv7` is the All-in-One multilingual base
# voice referenced by the repo samples; it is not in the system table but is
# accepted by the API.

QWEN_VOICES: list[dict] = [
    {"id": "longanfengyue", "name": "龙安风悦", "trait": "自然亲切音", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longanyuanfei", "name": "龙安元妃", "trait": "高傲妃子音", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longanlingxi", "name": "龙安灵希", "trait": "可爱甜美音", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longanxiaoxin", "name": "龙安小昕", "trait": "亲切活泼音", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longanhuan_v3.6", "name": "龙安欢", "trait": "欢脱元气女", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longjielidou_v3.6", "name": "龙杰力豆", "trait": "天真男童", "lang": "中文/英文",
     "group": "精品儿童"},
    {"id": "longpaopao_v3.6", "name": "龙泡泡", "trait": "软糯可爱音", "lang": "中文/英文",
     "group": "精品儿童"},
    {"id": "longhuohuo_v3.6", "name": "龙火火", "trait": "顽皮少年音", "lang": "中文/英文",
     "group": "角色音"},
    {"id": "longchuanshu_v3.6", "name": "龙川叔", "trait": "川普大叔音", "lang": "中文/英文",
     "group": "角色音"},
    {"id": "loongmary", "name": "loongmary", "trait": "温暖英音", "lang": "英文",
     "group": "精品英文"},
    {"id": "loongeva_v3.6", "name": "loongeva", "trait": "高智美音", "lang": "英文",
     "group": "精品英文"},
    {"id": "loongjohn", "name": "loongJohn", "trait": "沉稳亲切美音", "lang": "英文",
     "group": "精品英文"},
    {"id": "longanhuan_mtlv7", "name": "longanhuan_mtlv7", "trait": "多语言 All-in-One", "lang": "中文/英/日/韩等16种",
     "group": "多语言"},
]

# --- qwen-audio-3.0-tts-plus -------------------------------------------------

QWEN_PLUS_VOICES: list[dict] = [
    {"id": "longanlingxin", "name": "龙安灵心", "trait": "知心温暖音", "lang": "中文/英文",
     "group": "精品中文"},
    {"id": "longanlufeng", "name": "龙安鲁风", "trait": "明亮开朗音", "lang": "中文/英文",
     "group": "精品中文"},
]

# --- qwen-audio-3.1-tts-flash -------------------------------------------------
# Large multilingual catalogue. Every voice below was probed against the API.

_QWEN31_CN = [
    ("yuxiaoyun_v3.1", "于小云", "元气亲切自然"),
    ("qiaoxiaojiao_v3.1", "乔小娇", "俏丽可爱"),
    ("xiaxiaochen_v3.1", "夏小晨", "元气明亮"),
    ("anmingyuan_v3.1", "安明远", "清亮自然"),
    ("wenhuaiqing_v3.1", "温怀清", "清亮柔和"),
    ("anxiaolan_v3.1", "安小岚", "清甜纯净"),
    ("xieshurou_v3.1", "谢舒柔", "柔和知性"),
    ("baiqinglan_v3.1", "白清岚", "明亮清纯"),
    ("xuyuyuan_v3.1", "许玉远", "知性成熟"),
    ("anruorou_v3.1", "安若柔", "气声知性"),
    ("wenhuaizhi_v3.1", "闻怀之", "稳重成熟"),
    ("xiaoxingzhi_v3.1", "萧行之", "端庄贵气"),
    ("guyunshu_v3.1", "顾云舒", "成熟稳重"),
    ("huozhuoshi_v3.1", "霍拙石", "清亮男声"),
    ("yeqinghe_v3.1", "叶清禾", "亲切温柔"),
    ("yunhuanhuan_v3.1", "云欢欢", "高亢热情"),
    ("xuxiaoqiao_v3.1", "徐小俏", "自然俏皮"),
    ("baianran_v3.1", "白安然", "低沉浑厚"),
    ("xuyanchu_v3.1", "许言初", "沉稳磁性"),
    ("yezhiqing_v3.1", "叶知晴", "轻快自然"),
    ("andi_v3.1", "安迪", "ABC口音男"),
    ("anyuqing_v3.1", "安语晴", "甜妹"),
]

# Dialects and languages only these four cover, per the published table.
_QWEN31_MULTI = [
    ("longanhuan_v3.1", "龙安欢"),
    ("longanlingxin_v3.1", "龙安灵心"),
    ("longanfengyue_v3.1", "龙安风悦"),
    ("xunanchuan_v3.1", "许南川"),
]

_QWEN31_EN = [
    ("Emily_v3.1", "Emily"), ("Luna_v3.1", "Luna"), ("Eric_v3.1", "Eric"),
    ("Luca_v3.1", "Luca"), ("Abby_v3.1", "Abby"), ("Annie_v3.1", "Annie"),
    ("Ava_v3.1", "Ava"), ("Beth_v3.1", "Beth"), ("Betty_v3.1", "Betty"),
    ("Cally_v3.1", "Cally"), ("Cindy_v3.1", "Cindy"), ("Donna_v3.1", "Donna"),
    ("Andy_v3.1", "Andy"), ("Brian_v3.1", "Brian"), ("David_v3.1", "David"),
]

_QWEN31_OTHER = [
    ("longanyuanfei_v3.1", "龙安元妃"), ("longjielidou_v3.1", "龙杰力豆"),
    ("longanlingxi_v3.1", "龙安灵希"), ("longhuohuo_v3.1", "龙火火"),
    ("longyingtao_v3.1", "龙应桃"), ("longanya_v3.1", "龙安雅"),
    ("longwan_v3.1", "龙婉"), ("longxing_v3.1", "龙星"),
    ("longhua_v3.1", "龙华"), ("longhan_v3.1", "龙寒"),
    ("longanzhi_v3.1", "龙安智"), ("longzhe_v3.1", "龙哲"),
    ("longanyang_v3.1", "龙安洋"), ("libai_v3.1", "李白"),
    ("longling_v3.1", "龙铃"), ("longniuniu_v3.1", "龙牛牛"),
    ("longshanshan_v3.1", "龙闪闪"), ("longpaopao_v3.1", "龙泡泡"),
    ("loongstella_v3.1", "loongstella"), ("longyuan_v3.1", "龙媛"),
    ("longmiao_v3.1", "龙妙"), ("longsanshu_v3.1", "龙三叔"),
    ("longanli_v3.1", "龙安莉"), ("longanwen_v3.1", "龙安温"),
    ("longanlang_v3.1", "龙安朗"), ("longxiaoxia_v3.1", "龙小夏"),
    ("longanchong_v3.1", "龙安冲"),
]

QWEN_31_VOICES: list[dict] = (
    [
        {"id": vid, "name": name, "trait": "多语种·多方言", "lang": "8方言+7外语",
         "group": "多语种与方言"}
        for vid, name in _QWEN31_MULTI
    ]
    + [
        {"id": vid, "name": name, "trait": trait, "lang": "中文（普通话）", "group": "精品中文"}
        for vid, name, trait in _QWEN31_CN
    ]
    + [
        {"id": vid, "name": name, "trait": "英文音色", "lang": "英文", "group": "精品英文"}
        for vid, name in _QWEN31_EN
    ]
    + [
        {"id": vid, "name": name, "trait": "系统音色", "lang": "中文（普通话）", "group": "其他系统音色"}
        for vid, name in _QWEN31_OTHER
    ]
)


MODELS: dict[str, dict] = {
    "cosyvoice-v3-flash": {
        "label": "CosyVoice v3 Flash（推荐 · 音色最多）",
        "default_voice": "longanhuan",
        "voices": V3_VOICES,
        "groups": [
            "标杆音色", "社交陪伴", "语音助手", "客服", "有声书", "短视频配音",
            "新闻播报", "直播带货", "诗词朗诵", "童声", "方言", "出海营销",
        ],
        "supports_instruction": True,
    },
    "cosyvoice-v3-plus": {
        "label": "CosyVoice v3 Plus（质量更高）",
        "default_voice": "longanhuan",
        "voices": V3_PLUS_VOICES,
        "groups": ["标杆音色"],
        "supports_instruction": True,
    },
    "cosyvoice-v2": {
        "label": "CosyVoice v2（经典音色集）",
        "default_voice": "longxiaochun_v2",
        "voices": V2_VOICES,
        "groups": ["经典音色"],
        "supports_instruction": False,
    },
    "qwen-audio-3.0-tts-flash": {
        "label": "Qwen-Audio-3.0-TTS-Flash（支持自由风格指令）",
        "default_voice": "longanfengyue",
        "voices": QWEN_VOICES,
        "groups": ["精品中文", "精品儿童", "角色音", "精品英文", "多语言"],
        "supports_instruction": True,
    },
    "qwen-audio-3.0-tts-plus": {
        "label": "Qwen-Audio-3.0-TTS-Plus（旗舰）",
        "default_voice": "longanlingxin",
        "voices": QWEN_PLUS_VOICES,
        "groups": ["精品中文"],
        "supports_instruction": True,
    },
    "qwen-audio-3.1-tts-flash": {
        "label": "Qwen-Audio-3.1-TTS-Flash（多语种·方言最多）",
        "default_voice": "longanfengyue_v3.1",
        "voices": QWEN_31_VOICES,
        "groups": ["多语种与方言", "精品中文", "精品英文", "其他系统音色"],
        "supports_instruction": True,
    },
}

DEFAULT_MODEL = "cosyvoice-v3-flash"

# Probed against the live API: across all 89 voices only `longanhuan_v3`
# accepts a `请用<方言>表达。` instruction. Every other voice -- including
# `longanhuan` and `longanyang`, which look equivalent -- returns error 428.
DIALECT_VOICES = [v["id"] for v in V3_VOICES if v.get("dialect")]


def dialect_voice_for(model: str) -> str | None:
    """The dialect-capable voice for a model, if the model has one."""
    meta = MODELS.get(model)
    if not meta:
        return None
    for voice in meta["voices"]:
        if voice.get("dialect"):
            return voice["id"]
    return None


def catalogue() -> list[dict]:
    """Everything the frontend needs to drive the model/voice pickers."""
    return [
        {
            "id": key,
            "label": meta["label"],
            "default_voice": meta["default_voice"],
            "voices": meta["voices"],
            "groups": meta["groups"],
            "supports_instruction": meta["supports_instruction"],
            "dialect_voice": dialect_voice_for(key),
        }
        for key, meta in MODELS.items()
    ]


def voices_for(model: str) -> list[dict]:
    meta = MODELS.get(model)
    return meta["voices"] if meta else []


# A cloned voice id is `{target_model}-{prefix}-{unique}` and nothing else. It is
# the only place the target model appears in `list_voice`, which returns just
# voice_id / gmt_create / gmt_modified / status -- `query_voice` would return
# target_model but costs one round trip per voice.
#
# Matching is longest-prefix rather than a split on "-", because model ids
# contain dots and dashes themselves (`qwen-audio-3.0-tts-flash`). Longest-first
# matters as soon as one model id is a prefix of another: today
# `qwen-audio-3.0-tts` is not in the list, but adding it would otherwise shadow
# `qwen-audio-3.0-tts-flash`, since that id does start with `qwen-audio-3.0-tts-`.
def parse_clone_model(voice_id: str, models: "Sequence[str] | None" = None) -> str | None:
    """Recover the target model a cloned voice is bound to, from its id.

    Returns None for anything unrecognised rather than guessing: a wrong model
    here means the preview synthesises with the wrong voice and fails with 418,
    which reads as a broken voice rather than a parsing mistake.
    """
    if models is None:
        from .config import VOICE_CLONE_MODELS

        models = VOICE_CLONE_MODELS
    for model in sorted(models, key=len, reverse=True):
        if voice_id.startswith(f"{model}-"):
            return model
    return None


# Cloned voices also carry a user-chosen prefix, which is the only human-
# readable part of the id.
def parse_clone_prefix(voice_id: str) -> str:
    model = parse_clone_model(voice_id)
    if not model:
        return ""
    rest = voice_id[len(model) + 1:]
    # The trailing component is the unique suffix, not part of the prefix.
    return rest.rsplit("-", 1)[0] if "-" in rest else rest


# `list_voice` returns a raw status string. These are the three the API
# documents; anything else is shown verbatim rather than guessed at.
VOICE_STATUS_LABELS = {
    "OK": ("可用", "ok"),
    "DEPLOYING": ("审核中", "warn"),
    "UNDEPLOYED": ("审核未通过", "err"),
}


def voice_status_label(status: str) -> tuple[str, str]:
    """(label, css class) for a voice's enrollment status."""
    key = (status or "").strip().upper()
    if not key:
        return ("未知", "warn")
    return VOICE_STATUS_LABELS.get(key, (key, "warn"))


def default_voice_for(model: str) -> str:
    meta = MODELS.get(model)
    return meta["default_voice"] if meta else "longanhuan"


def supports_instruction(model: str) -> bool:
    meta = MODELS.get(model)
    return bool(meta and meta["supports_instruction"])


# Emotion / scene / dialect presets from the official Instruct reference.
# Scene lists are per-voice in the docs; these are the common ones and the API
# rejects a scene the chosen voice does not support, so the UI surfaces the
# failure rather than hiding it.
EMOTIONS = ["neutral", "fearful", "angry", "sad", "surprised", "happy", "disgusted"]

# The API only accepts the English enum, but the UI should not require reading
# English to pick an emotion.
EMOTION_LABELS = {
    "neutral": "中性",
    "fearful": "恐惧",
    "angry": "愤怒",
    "sad": "悲伤",
    "surprised": "惊讶",
    "happy": "开心",
    "disgusted": "厌恶",
}
SCENES = [
    "闲聊对话", "新闻播报", "广告促销", "比赛解说", "深夜电台广播",
    "剧情解说", "诗歌朗诵", "科普知识推广", "产品推广", "脱口秀表演",
    "语音导航", "一些儿童内容解说", "自由对话",
]
# Every value here was probed against the live API. The published reference
# also lists 普通话, but `请用普通话表达。` is rejected with error 428, so it is
# deliberately absent.
DIALECTS = ["广东话", "东北话", "河南话", "湖南话", "陕西话", "山东话", "四川话", "安徽话"]


def build_instruction(kind: str, value: str) -> str:
    """Assemble an Instruct string in the format the API requires."""
    kind = (kind or "").strip()
    value = (value or "").strip()
    if not kind or not value:
        return ""
    if kind == "emotion":
        return f"你说话的情感是{value}。"
    if kind == "scene":
        return f"你正在进行{value}，你说话的情感是neutral。"
    if kind == "dialect":
        return f"请用{value}表达。"
    return value


INSTRUCTION_KINDS = [
    {"id": "", "label": "无"},
    {"id": "emotion", "label": "情感"},
    {"id": "scene", "label": "场景 + 情感"},
    {"id": "dialect", "label": "方言"},
    {"id": "custom", "label": "自定义"},
]


# ---------------------------------------------------------------------------
# Instruct capabilities, per voice.
#
# Everything here was probed against the live API rather than taken from the
# published tables, because the tables are wrong in two places: `longanhuan`
# and `longhuhu_v3` are documented as supporting role instructions that the
# service rejects. Two further quirks worth knowing:
#
#   * scenes are disjoint per voice -- `longanyang` takes 闲聊互动 while
#     `longanhuan` takes 闲聊对话, and using the wrong one fails
#   * `longanhuan_v3` accepts dialect instructions but rejects every emotion
#     and scene, despite being listed as supporting Instruct generally
# ---------------------------------------------------------------------------

_ALL_EMOTIONS = ["neutral", "fearful", "angry", "sad", "surprised", "happy", "disgusted"]

# The API only accepts the English enum, but the UI should not require reading
# English to pick an emotion.
EMOTION_LABELS = {
    "neutral": "中性",
    "fearful": "恐惧",
    "angry": "愤怒",
    "sad": "悲伤",
    "surprised": "惊讶",
    "happy": "开心",
    "disgusted": "厌恶",
}

# Every qwen-audio-3.0/3.1 voice accepts instructions. Their instruction text
# is free-form natural language rather than a fixed template, but they also
# understand the same emotion / scene / role / identity sentences and the same
# dialect list as cosyvoice, which keeps the UI uniform across models.
_QWEN_PROFILE = {
    "emotions": _ALL_EMOTIONS,
    "scenes": ["新闻播报", "广告促销", "比赛解说", "语音导航", "脱口秀表演",
               "剧情解说", "诗歌朗诵", "产品推广", "有声书", "儿童故事"],
    "roles": ["一个旁白", "温和客服", "故事机"],
    "identities": ["故事机", "儿童玩具"],
    "dialects": ["广东话", "东北话", "河南话", "湖南话", "陕西话", "山东话", "四川话", "安徽话"],
}

INSTRUCT_PROFILES: dict[str, dict] = {
    "longanyang": {
        "emotions": _ALL_EMOTIONS,
        "scenes": ["闲聊互动", "新闻播报", "广告促销", "比赛解说", "一些儿童内容解说", "语音导航", "脱口秀表演"],
        "roles": ["一个旁白"],
        "identities": ["故事机"],
        "dialects": [],
    },
    "longanhuan": {
        "emotions": _ALL_EMOTIONS,
        "scenes": ["闲聊对话", "比赛解说", "深夜电台广播", "剧情解说", "诗歌朗诵", "科普知识推广", "产品推广", "脱口秀表演"],
        "roles": [],
        "identities": [],
        "dialects": [],
    },
    "longhuhu_v3": {
        "emotions": _ALL_EMOTIONS,
        "scenes": ["自由对话", "广告促销"],
        "roles": [],
        "identities": ["故事机"],
        "dialects": [],
    },
    "longanhuan_v3": {
        "emotions": [],
        "scenes": [],
        "roles": [],
        "identities": [],
        "dialects": ["广东话", "东北话", "河南话", "湖南话", "陕西话", "山东话", "四川话", "安徽话"],
    },
}

# Instruction kinds, in the order the UI offers them.
INSTRUCTION_KINDS_BY_PROFILE = [
    {"id": "", "label": "无"},
    {"id": "emotion", "label": "情感"},
    {"id": "scene", "label": "场景 + 情感"},
    {"id": "role", "label": "角色 + 情感"},
    {"id": "identity", "label": "身份 + 情感"},
    {"id": "dialect", "label": "方言"},
    {"id": "custom", "label": "自定义"},
]

_PROFILE_FIELD = {
    "emotion": "emotions",
    "scene": "scenes",
    "role": "roles",
    "identity": "identities",
    "dialect": "dialects",
    # "custom" is free-form, so it is always offered.
    "custom": None,
}


for _vid in (
    [v["id"] for v in QWEN_VOICES]
    + [v["id"] for v in QWEN_PLUS_VOICES]
    + [v["id"] for v in QWEN_31_VOICES]
):
    INSTRUCT_PROFILES.setdefault(_vid, dict(_QWEN_PROFILE))


def profile_for(voice_id: str) -> dict:
    """Verified instruction capabilities of one voice. Empty means unsupported."""
    return INSTRUCT_PROFILES.get(voice_id, {"emotions": [], "scenes": [], "roles": [], "identities": [], "dialects": []})


def instruction_kinds_for(voice_id: str) -> list[dict]:
    profile = profile_for(voice_id)
    return [
        kind for kind in INSTRUCTION_KINDS_BY_PROFILE
        if not kind["id"] or profile.get(_PROFILE_FIELD[kind["id"]])
    ]


def instruction_values_for(voice_id: str, kind: str) -> list[str]:
    if not kind:
        return []
    field = _PROFILE_FIELD.get(kind)
    return profile_for(voice_id).get(field, []) if field else []


def supports_instruct(voice_id: str) -> bool:
    return bool(instruction_kinds_for(voice_id)[1:])


CAPABILITY_LABEL = {
    "emotion": "情感",
    "scene": "场景",
    "role": "角色",
    "identity": "身份",
    "dialect": "方言",
}

CAPABILITY_ORDER = ["emotion", "scene", "role", "identity", "dialect"]


def capabilities_for(voice_id: str) -> list[str]:
    """Capability names of a voice, e.g. ['情感', '场景']."""
    profile = INSTRUCT_PROFILES.get(voice_id)
    if not profile:
        return []
    return [
        CAPABILITY_LABEL[key]
        for key in CAPABILITY_ORDER
        if profile.get(_PROFILE_FIELD[key])
    ]


def instruct_voices() -> list[dict]:
    """Every voice that accepts at least one instruction, for UI hints."""
    out = []
    for voice_id in INSTRUCT_PROFILES:
        meta = next(
            (v for v in V3_VOICES if v["id"] == voice_id),
            {"id": voice_id, "name": voice_id},
        )
        out.append(
            {
                "id": voice_id,
                "name": meta["name"],
                "capabilities": capabilities_for(voice_id),
            }
        )
    return out


# ---------------------------------------------------------------------------
# Inline emotion / non-verbal tags.
#
# These live inside `text` rather than `instruction` and are exclusive to the
# qwen-audio TTS models. Every entry below was probed against the API; the
# control tags apply to all following text within the same synthesis request,
# while the rich-language tags insert a one-off sound at that position.
# Source: https://help.aliyun.com/zh/model-studio/qwen-audio-tts
# ---------------------------------------------------------------------------

CONTROL_TAGS: list[dict] = [
    {"tag": "[sad]", "name": "悲伤"},
    {"tag": "[amazed]", "name": "惊叹"},
    {"tag": "[angry]", "name": "愤怒"},
    {"tag": "[excited]", "name": "兴奋"},
    {"tag": "[sarcastic]", "name": "讽刺"},
    {"tag": "[curious]", "name": "好奇"},
    {"tag": "[like dracula]", "name": "德古拉风格"},
    {"tag": "[bored]", "name": "无聊"},
    {"tag": "[tired]", "name": "疲惫"},
    {"tag": "[scornful]", "name": "轻蔑"},
    {"tag": "[shouting]", "name": "大喊"},
    {"tag": "[deep and loud shouting]", "name": "深沉大声呐喊"},
    {"tag": "[asmr]", "name": "ASMR 轻柔耳语"},
    {"tag": "[panicked]", "name": "恐慌"},
    {"tag": "[trembling]", "name": "颤抖"},
    {"tag": "[mischievously]", "name": "调皮"},
    {"tag": "[empathetic]", "name": "共情"},
    {"tag": "[whispers]", "name": "耳语"},
    {"tag": "[reluctantly]", "name": "不情愿"},
    {"tag": "[crying]", "name": "哭泣"},
    {"tag": "[serious]", "name": "严肃"},
    {"tag": "[very slowly]", "name": "非常缓慢"},
    {"tag": "[very fast]", "name": "非常快速"},
]

RICH_TAGS: list[dict] = [
    {"tag": "[gasp]", "name": "倒吸一口气"},
    {"tag": "[sighing]", "name": "叹息"},
    {"tag": "[clears throat]", "name": "清嗓"},
    {"tag": "[giggles]", "name": "咯咯笑"},
    {"tag": "[laughing]", "name": "大笑"},
    {"tag": "[cough]", "name": "咳嗽"},
    {"tag": "[snorts]", "name": "哼声嗤笑"},
]

# Models that understand inline tags.
TAG_MODELS = {
    "qwen-audio-3.0-tts-flash",
    "qwen-audio-3.0-tts-plus",
    "qwen-audio-3.1-tts-flash",
}

CONTROL_TAG_SET = {t["tag"] for t in CONTROL_TAGS}


def supports_tags(model: str) -> bool:
    return model in TAG_MODELS


def carry_control_tag(previous_tag: str, sentence: str) -> str:
    """Re-apply the previous control tag when a split sentence lost it.

    Tags apply for the remainder of one synthesis request, but this workbench
    synthesises sentence by sentence. Without carrying the tag forward, every
    sentence after the first would silently revert to the neutral voice.
    """
    if not previous_tag or sentence.lstrip().startswith("["):
        return sentence
    return f"{previous_tag}{sentence}"


def last_control_tag(text: str) -> str:
    """The final control tag appearing in `text`, or '' if there is none."""
    found = ""
    for tag in CONTROL_TAGS:
        if tag["tag"] in text:
            # Take the one that appears last.
            if text.rindex(tag["tag"]) > (text.rindex(found) if found else -1):
                found = tag["tag"]
    return found
