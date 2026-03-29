import re

# 千牛右侧数据条、角标等易被误当成买家昵称
_JUNK_BUYER_ID = re.compile(r"^\d+(?:\.\d+)?%$")
_PRICE_LIKE = re.compile(r"^[￥¥]?\s*[\d,]+(?:\.\d+)?\s*(?:元)?$")
# 纯小数金额（订单卡片常见 102.00）
_DECIMAL_MONEY_ONLY = re.compile(r"^[\d,]+(?:\.\d{2})\s*$")

_UI_LABEL_EXACT = frozenset(
    {
        "分享",
        "库存",
        "仓库",
        "首页",
        "数据",
        "商品",
        "订单",
        "营销",
        "交易",
        "服务",
        "插件",
        "应用",
    }
)

# 千牛右侧买家信息 / 订单卡片 / 物流 / 推荐区短标签（整句精确匹配，避免误杀真咨询）
_PANEL_LABEL_EXACT = frozenset(
    {
        # 时间
        "发货时间",
        "付款时间",
        "下单时间",
        "成交时间",
        "关闭时间",
        "创建时间",
        "预约配送",
        "预计送达",
        "送达时间",
        "签收时间",
        "退款时间",
        "申请时间",
        "处理时间",
        "剩余时间",
        "有效期至",
        "截止时间",
        # 物流
        "物流信息",
        "物流详情",
        "物流跟踪",
        "查看物流",
        "物流进度",
        "快递公司",
        "承运商",
        "配送方式",
        "自提点",
        "收货人",
        "收货地址",
        "发货地",
        "发货地址",
        "修改地址",
        "默认地址",
        "复制地址",
        "快递单号",
        "运单号",
        "物流单号",
        "发货单号",
        # 订单 / 交易
        "订单编号",
        "订单详情",
        "订单状态",
        "主订单",
        "子订单",
        "主子订单",
        "交易快照",
        "商品快照",
        "交易关闭",
        "交易成功",
        "等待买家付款",
        "等待卖家发货",
        "等待买家确认",
        "买家已付款",
        "卖家已发货",
        "已发货",
        "待发货",
        "待收货",
        "待评价",
        "已评价",
        "未评价",
        "已追评",
        "追评",
        "去评价",
        "写评价",
        "查看评价",
        "评价有礼",
        "双方已评",
        "买家已评",
        "卖家已评",
        "有图评价",
        "好评率",
        "退款中",
        "退款成功",
        "售后维权",
        "申请退款",
        "退换货",
        # 金额
        "实付款",
        "实收款",
        "应付金额",
        "商品总价",
        "订单金额",
        "优惠金额",
        "店铺优惠",
        "跨店满减",
        "运费",
        "服务费",
        "税费",
        "定金",
        "尾款",
        "分期付款",
        # 商品信息区
        "商品详情",
        "商品信息",
        "商品标题",
        "品牌",
        "型号",
        "货号",
        "SKU",
        "规格",
        "数量",
        "库存",
        "现货",
        "仓库中",
        "已售罄",
        "下架",
        # 右侧互动 / 足迹
        "足迹",
        "推荐",
        "猜你喜欢",
        "看了又看",
        "相似宝贝",
        "历史订单",
        "历史足迹",
        "浏览记录",
        "买家信息",
        "卖家信息",
        "联系买家",
        "店铺名片",
        "进店逛逛",
        # 客服操作
        "备注",
        "标旗",
        "星标",
        "置顶会话",
        "转交同事",
        "智能客服",
        "机器人回复",
        "推荐回复",
        "快捷短语",
        "常用语",
        # 空态 / 列表操作
        "暂无数据",
        "暂无订单",
        "暂无足迹",
        "加载中",
        "点击加载",
        "查看更多",
        "查看全部",
        "查看详情",
        "展开",
        "收起",
        "复制",
        "复制单号",
        "一键复制",
        # 千牛 / 平台提示短句
        "接待中心",
        "平台通知",
        "服务提醒",
        "违规预警",
        "点击直接查看",
        "点击查看详情",
        # 价保 / 规则类标题（易被扫成「消息」）
        "价保信息",
        "价保服务",
        "价保险",
        "价格保护",
        "发票信息",
        "保修信息",
        "赠品信息",
        "套餐信息",
        "活动信息",
        "优惠信息",
        "价格说明",
        "活动规则",
        "服务说明",
        "购买须知",
        "配送说明",
        "退换说明",
        "用户评价",
        "问大家",
        "宝贝评价",
    }
)

# 侧栏标题行：「前缀 + 信息/说明/须知/提示 + 冒号」，整句无正文（非买家完整问句）
_PANEL_INFO_HEADER_RE = re.compile(
    r"^[\u4e00-\u9fff]{2,14}(信息|说明|须知|提示)\s*[：:]\s*$"
)

# 订单/交易进度常见「已xx」状态角标（整句仅此三字）
_PANEL_STATUS_YI_RE = re.compile(
    r"^已(付款|发货|签收|评价|追评|关闭|确认|退款|成交)$"
)

# 聊天区消息头上方的时间戳显示（非买家发送内容）
_TIMESTAMP_ONLY_RE = re.compile(
    r"^(?:昨天|今天|今日|前天|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2})?"
    r"\s*\d{1,2}:\d{2}(?::\d{2})?$"
)

# 整句形态像商品/订单条（仅 fullmatch 级，避免「满200包邮」等真咨询被前缀误杀）
_PANEL_LINE_RE = (
    re.compile(r"^共\d+(件|个|款|条)$"),
    re.compile(r"^合计[：:]\s*[￥¥]?[\d,.]+$"),
)

# 订单/侧栏里单独一行的「字段名+冒号」无正文（如聊天区误扫到的「实收：」）；须 fullmatch，避免杀「实收是多少」
_PANEL_FIELD_COLON_STUB = re.compile(
    r"^(?:实收|实付|应收|应付|已收|已付|合计|小计|共计|总计|明细|运费|保价|优惠|折扣|立减|满减|单价|数量|件数|"
    r"库存|赠品|发票|快照|退款|售后|维权|物流|发货|收货|付款|下单|成交|价保|满赠|赠送|实发|实到|"
    r"买家留言|卖家备注|订单备注|交易说明|商品总额|店铺合计|平台优惠|红包|积分)"
    r"(?:金额|款|额|价|量|费|信息|说明|时间|状态)?[：:]\s*$"
)

# 会话元信息里单独一行的「角色+冒号」，无正文
_PANEL_ROLE_COLON_STUB = frozenset(
    ("买家：", "买家:", "卖家：", "卖家:", "客服：", "客服:", "店主：", "店主:", "系统：", "系统:", "平台：", "平台:", "店铺：", "店铺:", "掌柜：", "掌柜:")
)


def is_panel_colon_stub(text: str) -> bool:
    """整句仅为订单/金额区「字段名+冒号」或无正文的角色标签。"""
    t = (text or "").strip()
    if not t:
        return False
    if _PANEL_FIELD_COLON_STUB.match(t):
        return True
    if t in _PANEL_ROLE_COLON_STUB:
        return True
    return False


_SUBSTANTIVE = re.compile(r"[\u4e00-\u9fffA-Za-z0-9]|[？！?!]")

# 单字/碎片常被 OCR 或侧栏截断扫进「最后一条」（如「共」「件」）
_MIN_BUYER_MESSAGE_LEN = 2
# 短句里出现以下词且无问句痕迹时，多为订单/商品条，非买家打字
_SHORT_NOISE_KEYWORDS = (
    "库存",
    "销量",
    "SKU",
    "sku",
    "雇佣",
    "已评价",
    "订单",
    "物流",
    "收货",
    "付款",
)
_LIKELY_QUESTION_TAIL = re.compile(r"[？?！!吗呢嘛吧呀么咯蛤呐]$")
_LIKELY_QUESTION_HINT = (
    "怎么",
    "什么",
    "多少",
    "为什么",
    "为啥",
    "请问",
    "有没有",
    "能不能",
    "可以吗",
    "行吗",
    "多久",
    "几天",
    "包邮",
    "有货",
)

# 右侧面板常见「共 N 件」类碎片（非完整买家句）
_PANEL_COUNT_FRAG_RE = re.compile(r"^共\d*[件个台条款]?$")


def is_short_buyer_keyword_noise(text: str) -> bool:
    """
    短文本侧栏/订单噪声：含典型电商字段且不像问句。
    长句不据此拒绝（避免「订单什么时候发」被误杀）。
    """
    t = (text or "").strip()
    if len(t) < _MIN_BUYER_MESSAGE_LEN:
        return True
    if _PANEL_COUNT_FRAG_RE.match(t):
        return True
    if len(t) > 10:
        return False
    if _LIKELY_QUESTION_TAIL.search(t):
        return False
    for hint in _LIKELY_QUESTION_HINT:
        if hint in t:
            return False
    for kw in _SHORT_NOISE_KEYWORDS:
        if kw in t:
            return True
    if "￥" in t or "¥" in t:
        return True
    return False


def has_substantive_buyer_text(text: str) -> bool:
    """至少含一个汉字/字母/数字或明显问句标点；长度须 >=2，排除单字碎片。"""
    t = (text or "").strip()
    if len(t) < _MIN_BUYER_MESSAGE_LEN:
        return False
    return _SUBSTANTIVE.search(t) is not None


def _looks_like_buyer_question(t: str) -> bool:
    """含明显问句形态时，不因正文里出现「订单/物流」等词整体判为系统提示。"""
    if _LIKELY_QUESTION_TAIL.search(t):
        return True
    for hint in _LIKELY_QUESTION_HINT:
        if hint in t:
            return True
    return False


# 千牛系统横幅关键词（UIA和OCR路径共用）
_BANNER_SUBSTR = (
    "当前消息较多",
    "点此快速获取",
    "集中处理",
    "消息较多",
    "快速获取买家",
    "7天内自动总结",
    "AI一键总结",
    "AI咨询摘要",
    "一键总结",
    "自动总结",
)


def _is_qianniu_banner_text(text: str) -> bool:
    """
    检测是否为千牛系统横幅文本。
    增加问句豁免：若文本含 banner 关键词但同时像买家问句，则不判定为横幅。
    增加空格容忍：OCR识别的文本可能包含空格。
    """
    t = (text or "").strip()
    if not t:
        return True
    # 标准化：去除所有空格，便于匹配
    t_normalized = re.sub(r"\s+", "", t)
    for s in _BANNER_SUBSTR:
        # 原始匹配
        if s in t:
            # 问句豁免：如果是买家问句（如"退款怎么办"），不误判为横幅
            if _looks_like_buyer_question(t):
                return False
            return True
        # 标准化匹配（去除空格后）
        s_normalized = re.sub(r"\s+", "", s)
        if s_normalized in t_normalized:
            if _looks_like_buyer_question(t):
                return False
            return True
    return False


_SYSTEM_HINTS = (
    "订单",
    "物流",
    "退款",
    "已发货",
    "已签收",
    "支付成功",
    "系统消息",
    "淘宝通知",
    "天猫通知",
    "旺旺消息",
    "邀请下单",
    "催付",
    "卡片消息",
    "[交易",
    "【交易",
    "您购买的",
    "商品快照",
    "退换货",
    "维权",
    # 卖家自动欢迎语关键词（有问句豁免保护）
    "欢迎光临",
    "欢迎来到",
    "小迷妹",
    "小迷弟",
    "小仙女",
    "亲爱的顾客",
    "亲亲您好",
    "亲，您好",
    "亲你好",
    "很高兴为您服务",
    "有什么可以帮您",
    "有什么需要",
    "为您服务",
    "自动回复",
)

# 系统通知消息正则（句首匹配，无需问句保护，因为模式足够精确）
# 用于过滤千牛系统推送的交易状态、物流、评价等通知
_SYSTEM_NOTIFICATION_RE = (
    re.compile(r"^(您的)?订单.*已(创建|发货|签收|关闭|退款)"),
    re.compile(r"^(买家|卖家)已(付款|发货|签收|确认|评价)"),
    re.compile(r"^交易(创建成功|成功|关闭)"),
    re.compile(r"^退款(成功|已到账|关闭|取消)"),
    re.compile(r"^快递已?(签收|揽收|派送|发货)"),
    re.compile(r"^包裹.*派送"),
    re.compile(r"^请对本次服务"),
    re.compile(r"^邀请您.*评价"),
    re.compile(r"^以下[为是].*消息"),
    re.compile(r"^系统(提示|通知|消息)"),
    re.compile(r"^自动回复"),
    re.compile(r"^机器人"),
)

# ========== Fix 3a: 商品卡片文本过滤 ==========
# 匹配商品卡片价格格式："价格：9999.00" / "售价:9999" / "￥ 9,999.00" 等
_PRODUCT_CARD_PRICE_RE = re.compile(
    r"^(价格|售价|原价|到手价|优惠价|活动价|拍下|下单)[：:]?\s*[￥¥]?\s*[\d,]+(?:\.\d+)?"
)

# 匹配商品卡片内常见文字片段（整句匹配）
_PRODUCT_CARD_TEXT_PATTERNS = [
    re.compile(r"^[\d,]+(?:\.\d{2})?\s*[元件个台]$"),  # "102.00 元", "99 件"
    re.compile(r"^共\d+[件个条]$"),  # "共1件", "共2个"
    re.compile(r"^(立即购买|去购买|去下单|马上抢|加入购物车|立即下单|确认下单)$"),
    re.compile(r"^(查看宝贝|查看详情|进店看看|去逛逛|去看看|查看商品)$"),
    re.compile(r"^(已拍下|已下单|已付款|待发货|待付款|待评价)$"),
    re.compile(r"^(月销|已售|库存|销量)[：:]?\s*[\d,]+"),
    re.compile(r"^库存\d+[件个]$"),  # "库存99件"
    re.compile(r"^剩余\d+[件个]$"),  # "剩余5件"
]


def is_product_card_text(text: str) -> bool:
    """
    判断文本是否来自商品/订单卡片。
    问句豁免：如果像买家问句，返回False（不误杀真实咨询）。
    """
    t = (text or "").strip()
    if not t:
        return True

    # 问句豁免：如果像买家问句，不判定为卡片
    if _looks_like_buyer_question(t):
        return False

    # 价格格式匹配
    if _PRODUCT_CARD_PRICE_RE.match(t):
        return True

    # 其他商品卡片文本模式匹配
    for pat in _PRODUCT_CARD_TEXT_PATTERNS:
        if pat.match(t):
            return True

    return False


def is_ocr_noise_message(text: str) -> bool:
    """
    OCR 在聊天列里扫到的订单价、纯数字条等，非客户打字内容。
    （比 is_system_message 更偏「金额/货号形态」，用于 OCR 路径。）
    """
    t = (text or "").strip()
    if not t:
        return True
    # 聊天区消息头上方的时间戳显示（非买家发送内容）
    if _TIMESTAMP_ONLY_RE.match(t):
        return True
    if _PRICE_LIKE.match(t):
        return True
    if _DECIMAL_MONEY_ONLY.match(t.replace(" ", "")):
        return True
    if re.fullmatch(r"[￥¥]\s*[\d,.]+", t.replace(" ", "")):
        return True
    if re.fullmatch(r"[\d,]+(?:\.\d{1,4})?", t.replace(",", "")) and len(t) <= 14:
        return True
    # 订单号/运单号碎片过滤（OCR 识别到的订单卡片中的长数字）
    # 纯长数字（12位以上）
    if re.fullmatch(r"\d{12,}", t):
        return True
    # "订单号：xxx" 或 "订单号: xxx" 格式
    if re.match(r"^订单号[：:]?\s*\d+", t):
        return True
    # "运单号"/"快递单号"/"物流单号" + 字母数字
    if re.match(r"^(运单号|快递单号|物流单号)[：:]?\s*[A-Za-z0-9]+", t):
        return True
    # "价格：xxx" 格式（右侧商品/订单信息）
    if re.match(r"^价格[：:]\s*[\d,]+(?:\.\d+)?", t):
        return True
    # "¥xxx" 或 "￥xxx" 价格格式（订单金额）
    if re.match(r"^[¥￥]\s*[\d,]+(?:\.\d+)?", t):
        return True
    # "共x件" / "共x个" 商品数量格式
    if re.match(r"^共\d+[件个条]", t):
        return True
    # "ID" 单独出现（右侧商品ID/订单ID）
    if t == "ID" or re.match(r"^ID[：:]\s*\w+", t):
        return True
    # 长数字（15位以上，订单号/商品ID）
    if re.fullmatch(r"\d{15,}", t):
        return True
    # "订单" 开头且包含数字（如"订单2261674959339979893"）
    if re.match(r"^订单\d{10,}", t):
        return True
    # "商品ID" / "宝贝ID" / "SKUID"
    if re.match(r"^(商品|宝贝|SKU|item)[_-]?ID[：:]?\s*\w*", t, re.I):
        return True
    # Fix 3a: 增强价格格式过滤（商品卡片常见格式）
    # "价格：xxx" / "售价：xxx" / "原价：xxx"（带中文前缀）
    if re.match(r"^(价格|售价|原价|到手价)[：:]\s*[￥¥]?[\d,.]+", t):
        return True
    # "¥ 9999.00" / "￥ 9,999.00"（货币符号后带空格）
    if re.match(r"^[￥¥]\s+[\d,]+(?:\.\d{2})?", t):
        return True
    # 商品卡片常见格式：数字+元/件/个
    if re.match(r"^[\d,]+(?:\.\d{2})?\s*[元件个]$", t):
        return True
    return False


def is_non_message_ui_text(text: str) -> bool:
    """
    千牛聊天区占位/状态文案，不是买家发送的内容。
    仅用整句匹配，避免把「对方输入慢」等真咨询误判掉。
    """
    t = (text or "").strip()
    if not t:
        return True
    core = re.sub(r"[.。…·\s]+$", "", t).strip()
    # 常见：双方输入中 / 对方输入中 / 对方正在输入…
    if re.fullmatch(r"(双方输入中|对方输入中|对方正在输入|正在输入)(\.{0,3}|…{0,2})?", core):
        return True
    if core in ("说点什么", "点此输入", "请输入消息"):
        return True
    return False


def is_system_message(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return True
    if is_non_message_ui_text(t):
        log.info("[消息过滤] is_non_message_ui_text 过滤: %r", t[:20])
        return True
    if is_panel_colon_stub(t):
        log.info("[消息过滤] is_panel_colon_stub 过滤: %r", t[:20])
        return True
    if is_ocr_noise_message(t):
        log.info("[消息过滤] is_ocr_noise_message 过滤: %r", t[:20])
        return True
    # Fix 3a: 商品卡片文本过滤
    if is_product_card_text(t):
        log.info("[消息过滤] is_product_card_text 过滤: %r", t[:20])
        return True
    log.info("[消息过滤] 通过所有过滤: %r", t[:20])
    if len(t) > 2000:
        return True
    if t in _UI_LABEL_EXACT:
        return True
    if t in _PANEL_LABEL_EXACT:
        return True
    t_no_colon = re.sub(r"[：:]\s*$", "", t)
    if t_no_colon in _PANEL_LABEL_EXACT:
        return True
    if _PANEL_INFO_HEADER_RE.fullmatch(t):
        return True
    if _PANEL_STATUS_YI_RE.fullmatch(t):
        return True
    for pat in _PANEL_LINE_RE:
        if pat.match(t):
            return True
    if re.match(r"^仓库中\(\d+\)$", t):
        return True
    # 系统通知正则检查（句首匹配，无需问句保护）
    for pat in _SYSTEM_NOTIFICATION_RE:
        if pat.match(t):
            return True
    for h in _SYSTEM_HINTS:
        if h in t:
            if _looks_like_buyer_question(t) and len(t) >= 5:
                continue
            return True
    # 横幅文本过滤（UIA路径复用OCR的横幅过滤逻辑）
    if _is_qianniu_banner_text(t):
        log.info("[消息过滤] _is_qianniu_banner_text 过滤: %r", t[:20])
        return True
    if is_short_buyer_keyword_noise(t):
        return True
    return False


_TIME_TAIL = re.compile(
    r"(?:\s|^)(\d{1,2}:\d{2}(?::\d{2})?)\s*$"
)
# 气泡内常见日期前缀（与 HH:mm 二选一或并存）
_DATE_HINT = re.compile(r"(昨天|今日|今天|前天|\d{1,2}[-/月]\d{1,2})")


def extract_time_token(text: str) -> str | None:
    """从气泡文案末尾取 HH:mm（或 :ss），用于区分同文不同条。"""
    m = _TIME_TAIL.search((text or "").strip())
    return m.group(1) if m else None


def extract_date_time_hints(text: str) -> str:
    """尾缀时钟以外的日期词（与 extract_time_token 互补）。"""
    t = (text or "").strip()
    if not t:
        return ""
    parts = [m.group(1) for m in _DATE_HINT.finditer(t)]
    return "|".join(parts) if parts else ""


def normalize_buyer_id(raw: str) -> str:
    s = (raw or "").strip()
    s = re.sub(r"\s+", " ", s)
    if not s:
        return "unknown_buyer"
    compact = re.sub(r"\s+", "", s)
    if _JUNK_BUYER_ID.match(compact):
        return "active_chat"
    if _PRICE_LIKE.match(s.strip()):
        return "active_chat"
    if re.fullmatch(r"[\d.,\s]+", s.strip()):
        return "active_chat"
    return s


def fingerprint_key(
    buyer_id: str,
    message: str,
    time_token: str | None,
    bubble_bottom_y: float | None = None,
) -> str:
    """
    唯一标识「这一回合买家消息」：正文 + 解析到的时间 + 气泡在屏幕上的底边 Y。
    同一句文案新发一条时，时间或 Y 通常与上一条不同；仅点开会话不发送时仍显示旧气泡则与已处理指纹一致。
    """
    msg = (message or "").strip()
    tt = time_token if time_token else "__no_ts__"
    hints = extract_date_time_hints(msg)
    th = hints if hints else "__no_date__"
    if bubble_bottom_y is not None:
        yb = f"{float(bubble_bottom_y):.1f}"
    else:
        yb = "__no_y__"
    return f"{buyer_id}\x1f{msg}\x1f{tt}\x1f{th}\x1f{yb}"
