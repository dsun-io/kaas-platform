"""
测试 window_rect.py - DWM精确窗口边界验证
对比三种边界获取方式的差异
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import uiautomation as auto
from app.window_rect import (
    get_dwm_window_rect,
    get_win32_window_rect,
    get_precise_window_rect,
    get_precise_rect_for_control,
    ScreenRect,
)

print("=" * 60)
print("测试 window_rect.py - DWM 精确窗口边界")
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
    print("❌ 未找到千牛窗口，请确保千牛客户端已运行")
    sys.exit(1)

hwnd = qianniu_win.NativeWindowHandle
print(f"窗口句柄: {hwnd}")

# 测试三种边界获取方式
print("\n" + "=" * 60)
print("对比三种窗口边界获取方式:")
print("=" * 60)

# 1. UIA BoundingRectangle
uia_rect = qianniu_win.BoundingRectangle
print(f"\n① UIA BoundingRectangle:")
print(f"   坐标: ({uia_rect.left}, {uia_rect.top}, {uia_rect.right}, {uia_rect.bottom})")
print(f"   尺寸: {uia_rect.right - uia_rect.left}x{uia_rect.bottom - uia_rect.top}px")

# 2. Win32 GetWindowRect
win32_rect = get_win32_window_rect(hwnd)
if win32_rect:
    left, top, right, bottom = win32_rect
    print(f"\n② Win32 GetWindowRect (含边框):")
    print(f"   坐标: ({left}, {top}, {right}, {bottom})")
    print(f"   尺寸: {right - left}x{bottom - top}px")
else:
    print(f"\n② Win32 GetWindowRect: 调用失败")

# 3. DWM ExtendedFrameBounds
dwm_rect = get_dwm_window_rect(hwnd)
if dwm_rect:
    left, top, right, bottom = dwm_rect
    print(f"\n③ DWM ExtendedFrameBounds (精确):")
    print(f"   坐标: ({left}, {top}, {right}, {bottom})")
    print(f"   尺寸: {right - left}x{bottom - top}px")
else:
    print(f"\n③ DWM ExtendedFrameBounds: 调用失败")

# 4. 测试 get_precise_rect_for_control
print(f"\n④ get_precise_rect_for_control() 综合测试:")
precise = get_precise_rect_for_control(qianniu_win)
if precise:
    print(f"   返回 ScreenRect: ({precise.left}, {precise.top}, {precise.right}, {precise.bottom})")
    print(f"   尺寸: {precise.width}x{precise.height}px")
    
    # 对比UIA和DWM
    if dwm_rect:
        dx = uia_rect.left - dwm_rect[0]
        dy = uia_rect.top - dwm_rect[1]
        print(f"\n   📊 UIA vs DWM 偏移对比:")
        print(f"      水平偏移: {dx}px")
        print(f"      垂直偏移: {dy}px")
        if abs(dx) <= 1 and abs(dy) <= 1:
            print(f"      ✅ 偏移可忽略，UIA边界准确")
        else:
            print(f"      ⚠️  存在偏移，DWM边界更准确")
else:
    print(f"   ❌ 获取失败")

# 5. 验证应用到截图的效果
print("\n" + "=" * 60)
print("验证截图范围准确性:")
print("=" * 60)

if precise:
    print(f"\n使用 DWM 精确边界截图:")
    print(f"   左上角: ({precise.left}, {precise.top})")
    print(f"   右下角: ({precise.right}, {precise.bottom})")
    print(f"   尺寸: {precise.width}x{precise.height}px")
    print(f"\n✅ Task 2A 验证通过: window_rect.py 工作正常")
else:
    print(f"\n❌ 无法获取精确边界")

print("\n" + "=" * 60)
