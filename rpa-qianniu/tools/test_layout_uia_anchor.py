"""
测试区域布局UIA锚定 - Task 2C
验证使用右侧面板Pane边界作为布局锚点
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import uiautomation as auto
from app.vision_layout import (
    find_right_panel_boundary,
    layout_from_uia_anchors,
    rect_from_window,
    layout_from_rect,
)
from app.window_rect import get_precise_rect_for_control

print("=" * 60)
print("测试区域布局UIA锚定 - Task 2C")
print("=" * 60)

# 查找千牛窗口
windows = auto.GetRootControl().GetChildren()
qianniu_win = None

for win in windows:
    name = win.Name
    if "千牛" in name or "AliWorkbench" in name or "接待中心" in name:
        qianniu_win = win
        print(f"\n找到窗口: {name}")
        break

if not qianniu_win:
    print("❌ 未找到千牛窗口")
    sys.exit(1)

# 获取窗口矩形
window_rect = rect_from_window(qianniu_win)
print(f"\n窗口矩形: ({window_rect.left}, {window_rect.top}, {window_rect.right}, {window_rect.bottom})")
print(f"窗口尺寸: {window_rect.w}x{window_rect.h}px")

# 测试 find_right_panel_boundary
print("\n" + "=" * 60)
print("测试 find_right_panel_boundary():")
print("=" * 60)

right_boundary = find_right_panel_boundary(qianniu_win)

if right_boundary:
    print(f"\n✅ 找到右侧面板左边界: x = {right_boundary}px")
    
    # 计算比例
    ratio = (right_boundary - window_rect.left) / window_rect.w
    print(f"   相对窗口左侧比例: {ratio:.2%}")
    print(f"   聊天区域宽度: {right_boundary - window_rect.left}px")
    print(f"   右侧面板宽度: {window_rect.right - right_boundary}px")
else:
    print(f"\n⚠️  未找到右侧面板边界")

# 测试 layout_from_uia_anchors
print("\n" + "=" * 60)
print("测试 layout_from_uia_anchors():")
print("=" * 60)

uia_layout = layout_from_uia_anchors(qianniu_win, window_rect)

if uia_layout:
    print(f"\n✅ 成功构建UIA锚定布局:")
    print(f"   左侧面板: ({uia_layout.left_panel.left}, {uia_layout.left_panel.top}) - "
          f"({uia_layout.left_panel.right}, {uia_layout.left_panel.bottom})")
    print(f"   聊天面板: ({uia_layout.chat_panel.left}, {uia_layout.chat_panel.top}) - "
          f"({uia_layout.chat_panel.right}, {uia_layout.chat_panel.bottom})")
    print(f"   右侧面板: ({uia_layout.right_panel.left}, {uia_layout.right_panel.top}) - "
          f"({uia_layout.right_panel.right}, {uia_layout.right_panel.bottom})")
    print(f"   消息区域: ({uia_layout.message_area.left}, {uia_layout.message_area.top}) - "
          f"({uia_layout.message_area.right}, {uia_layout.message_area.bottom})")
    print(f"   输入区域: ({uia_layout.input_area.left}, {uia_layout.input_area.top}) - "
          f"({uia_layout.input_area.right}, {uia_layout.input_area.bottom})")
    print(f"   校准来源: {uia_layout.cal_source}")
else:
    print(f"\n⚠️  UIA锚定布局失败，将使用 .env 比例或OCR校准")

# 对比 .env 比例布局
print("\n" + "=" * 60)
print("对比 .env 比例布局:")
print("=" * 60)

ratio_layout = layout_from_rect(window_rect)
print(f"\n.env 比例布局:")
print(f"   左侧面板结束: x = {ratio_layout.left_panel.right}px")
print(f"   聊天面板结束: x = {ratio_layout.chat_panel.right}px")
print(f"   校准来源: {ratio_layout.cal_source}")

# 对比差异
if uia_layout:
    print(f"\n📊 UIA锚定 vs .env 比例对比:")
    print(f"   聊天面板右侧边界:")
    print(f"      UIA锚定: x = {uia_layout.chat_panel.right}px")
    print(f"      .env比例: x = {ratio_layout.chat_panel.right}px")
    diff = abs(uia_layout.chat_panel.right - ratio_layout.chat_panel.right)
    print(f"      差异: {diff}px")
    
    if diff < 50:
        print(f"      ✅ 差异较小，两种方法基本一致")
    else:
        print(f"      ⚠️  差异较大，UIA锚定更精确")

print("\n" + "=" * 60)
print("📊 测试总结:")
print("=" * 60)

task2c_pass = right_boundary is not None and uia_layout is not None

print(f"""
Task 2C 验证要点:
1. 右侧面板Pane查找: {'✅ 通过' if right_boundary else '❌ 失败'}
2. UIA锚定布局构建: {'✅ 通过' if uia_layout else '❌ 失败'}
3. cal_source标记: {'✅ 正确' if uia_layout and uia_layout.cal_source == 'uia_anchor' else '⚠️ 需检查'}

总体评估: {'✅ Task 2C 验证通过' if task2c_pass else '⚠️ 需要检查'}
""")

print("=" * 60)
