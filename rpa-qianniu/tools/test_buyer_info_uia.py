"""
测试买家信息UIA直读 - Task 2B
验证从右侧面板直接读取买家昵称功能
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import uiautomation as auto
from app.qianniu_driver import _read_buyer_info_from_right_panel, guess_active_buyer_title

print("=" * 60)
print("测试买家信息UIA直读 - Task 2B")
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

# 测试 _read_buyer_info_from_right_panel
print("\n" + "=" * 60)
print("测试 _read_buyer_info_from_right_panel():")
print("=" * 60)

buyer_info = _read_buyer_info_from_right_panel(qianniu_win)

if buyer_info:
    print(f"\n✅ 成功读取买家信息:")
    print(f"   昵称: {buyer_info.get('nickname', 'N/A')}")
else:
    print(f"\n⚠️  未从右侧面板读取到有效买家信息")
    print(f"   可能原因: 当前无活跃会话/右侧面板未加载")

# 测试 guess_active_buyer_title（集成UIA直读）
print("\n" + "=" * 60)
print("测试 guess_active_buyer_title()（已集成UIA直读）:")
print("=" * 60)

buyer_title = guess_active_buyer_title(qianniu_win)

if buyer_title and buyer_title != "active_chat":
    print(f"\n✅ 识别到买家: {buyer_title}")
    print(f"   如果上方 _read_buyer_info_from_right_panel 返回了昵称，")
    print(f"   说明 Task 2B 的 UIA 直读逻辑已生效")
else:
    print(f"\n⚠️  买家识别结果: {buyer_title}")
    print(f"   可能原因: 当前会话状态或面板未加载")

print("\n" + "=" * 60)
print("📊 测试总结:")
print("=" * 60)
print(f"""
Task 2B 验证要点:
1. 右侧面板Pane检测: {'✅ 通过' if buyer_info else '⚠️ 需检查'}
2. 买家昵称提取: {'✅ 通过' if buyer_info and buyer_info.get('nickname') else '⚠️ 需检查'}
3. 集成到guess_active_buyer_title: {'✅ 已集成' if buyer_title else '⚠️ 需检查'}

说明: 
- 当前千牛窗口需要有活跃的买家会话
- 右侧面板需要显示买家信息（昵称、信用分等）
- 如果没有活跃会话，测试会显示"⚠️ 需检查"，这是正常的
""")

print("=" * 60)
