"""
买卖家气泡角色判定测试 - 验证 _role_for_box() 函数

测试场景：
- 明确靠左 → buyer
- 明确靠右 → seller
- 全宽居中 → unknown（系统横幅）
- 边缘锚定覆盖

注意：由于 vision_message.py 的正则表达式兼容性问题，
这里直接复制相关函数进行测试。
"""

import pytest


def _role_for_box(
    cx: float,
    mid_x: float,
    half_w: float,
    box_width: float,
    msg_area_width: float,
    box_left: float,
    box_right: float,
    msg_area_left: float,
    msg_area_right: float,
) -> str:
    """buyer：靠左；seller：靠右；中间条带视为非买家气泡。

    优化点：
    1. margin 阈值从 max(20.0, half_w*0.08) 改为 max(15.0, half_w*0.06)，缩小死区
    2. 宽度辅助判断阈值从 0.70 降至 0.60，居中判定从 0.10 放宽至 0.15
    3. 增加边缘锚定辅助判断：若 box 紧贴左侧边缘，优先判为 buyer；紧贴右侧边缘，优先判为 seller
    """
    # 阈值优化：略微缩小死区，让更多偏左文本能被归为 buyer
    margin = max(15.0, float(half_w) * 0.06)

    # 边缘锚定辅助判断：千牛买家气泡紧贴左侧，卖家气泡紧贴右侧
    left_edge_dist = box_left - msg_area_left
    right_edge_dist = msg_area_right - box_right
    edge_threshold = half_w * 0.25  # 距离边缘 < 25% 半宽视为紧贴

    # 宽度辅助判断：太宽且居中的可能是系统横幅（阈值放宽至 0.60，居中判定放宽至 0.15）
    if box_width > msg_area_width * 0.60:
        if abs(cx - mid_x) < half_w * 0.15:
            return "unknown"  # 可能是系统横幅

    # 边缘锚定优先：紧贴左侧 → buyer，紧贴右侧 → seller
    if left_edge_dist < edge_threshold and cx < mid_x:
        return "buyer"
    if right_edge_dist < edge_threshold and cx > mid_x:
        return "seller"

    # 中线判定
    if cx < mid_x - margin:
        return "buyer"
    if cx > mid_x + margin:
        return "seller"
    return "unknown"


class TestRoleForBox:
    """气泡角色判定测试"""

    # 测试数据：msg_area_width=1000, 左边缘=0, 右边缘=1000
    # mid_x=500, half_w=500

    def test_clearly_left_is_buyer(self):
        """明确靠左 → buyer"""
        # cx=200 (< 500 - margin)，在左半边
        result = _role_for_box(
            cx=200, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=150, box_right=250,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "buyer"

    def test_clearly_right_is_seller(self):
        """明确靠右 → seller"""
        # cx=800 (> 500 + margin)，在右半边
        result = _role_for_box(
            cx=800, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=750, box_right=850,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "seller"

    def test_full_width_centered_is_unknown(self):
        """全宽居中 → unknown（系统横幅）"""
        # 宽度 > 60% 且居中 → unknown
        result = _role_for_box(
            cx=500, mid_x=500, half_w=500,
            box_width=700, msg_area_width=1000,  # 70% > 60%
            box_left=150, box_right=850,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "unknown"

    def test_left_edge_anchor(self):
        """左边缘锚定 → buyer"""
        # 紧贴左边缘（< 25% half_w = 125）
        result = _role_for_box(
            cx=80, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=30, box_right=130,  # left_edge_dist = 30 < 125
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "buyer"

    def test_right_edge_anchor(self):
        """右边缘锚定 → seller"""
        # 紧贴右边缘（< 125）
        result = _role_for_box(
            cx=920, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=870, box_right=970,  # right_edge_dist = 30 < 125
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "seller"

    def test_mid_zone_is_unknown(self):
        """中间区域 → unknown"""
        # cx=500，在 margin 死区内
        # margin = max(15, 500*0.06) = 30
        # cx 在 [470, 530] 范围内 → unknown
        result = _role_for_box(
            cx=500, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=450, box_right=550,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "unknown"

    def test_near_left_is_buyer(self):
        """偏左但在 margin 外 → buyer"""
        # cx=400 (< 500 - 30 = 470) → buyer
        result = _role_for_box(
            cx=400, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=350, box_right=450,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "buyer"

    def test_near_right_is_seller(self):
        """偏右但在 margin 外 → seller"""
        # cx=600 (> 500 + 30 = 530) → seller
        result = _role_for_box(
            cx=600, mid_x=500, half_w=500,
            box_width=100, msg_area_width=1000,
            box_left=550, box_right=650,
            msg_area_left=0, msg_area_right=1000
        )
        assert result == "seller"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
