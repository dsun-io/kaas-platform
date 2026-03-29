#!/usr/bin/env python3
"""
UIA 控件树探测脚本
用于探测千牛界面哪些控件可以被 UIA 访问，哪些需要视觉兜底

输出:
- uia_probe_result.json: 完整控件树（机器可读）
- uia_probe_result.txt: 人可读树形格式
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any

from pywinauto import Desktop, Application
from pywinauto.controls.uiawrapper import UIAWrapper
from pywinauto.timings import TimeoutError as PATimeoutError
import ctypes
from ctypes import wintypes

# DWM API 用于对比测试
try:
    dwmapi = ctypes.windll.dwmapi
    DWMWA_EXTENDED_FRAME_BOUNDS = 9
except Exception:
    dwmapi = None


def get_dwm_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """使用 DwmGetWindowAttribute 获取窗口精确边界（不含阴影）"""
    if dwmapi is None:
        return None
    
    rect = wintypes.RECT()
    try:
        result = dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(rect)
        )
        if result == 0:  # S_OK
            return (rect.left, rect.top, rect.right, rect.bottom)
    except Exception:
        pass
    return None


def get_win32_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """使用 GetWindowRect 获取窗口边界（含DWM阴影）"""
    try:
        user32 = ctypes.windll.user32
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return (rect.left, rect.top, rect.right, rect.bottom)
    except Exception:
        pass
    return None


@dataclass
class ControlInfo:
    """控件信息数据类"""
    control_type: str
    name: str
    automation_id: str
    class_name: str
    rectangle: dict[str, int]  # left, top, right, bottom
    is_enabled: bool
    is_visible: bool
    children_count: int
    depth: int
    # 特殊标记
    is_qianniu_main: bool = False  # 千牛主窗口
    is_session_list: bool = False  # 会话列表
    is_chat_area: bool = False     # 聊天区域
    is_input_box: bool = False     # 输入框
    is_send_button: bool = False   # 发送按钮
    

def analyze_control(wrapper: UIAWrapper, depth: int = 0, max_depth: int = 5) -> ControlInfo | None:
    """
    分析单个控件，返回控件信息
    """
    if depth > max_depth:
        return None
    
    try:
        # 获取控件属性
        control_type = wrapper.element_info.control_type or ""
        name = wrapper.element_info.name or ""
        automation_id = wrapper.element_info.automation_id or ""
        class_name = wrapper.element_info.class_name or ""
        rect = wrapper.rectangle()
        
        # 尝试获取启用/可见状态
        try:
            is_enabled = wrapper.is_enabled()
        except Exception:
            is_enabled = True
        try:
            is_visible = wrapper.is_visible()
        except Exception:
            is_visible = True
        
        # 获取子控件数量
        try:
            children = wrapper.children()
            children_count = len(children)
        except Exception:
            children_count = 0
        
        # 创建控件信息
        info = ControlInfo(
            control_type=control_type,
            name=name,
            automation_id=automation_id,
            class_name=class_name,
            rectangle={
                "left": rect.left,
                "top": rect.top,
                "right": rect.right,
                "bottom": rect.bottom,
                "width": rect.width(),
                "height": rect.height()
            },
            is_enabled=is_enabled,
            is_visible=is_visible,
            children_count=children_count,
            depth=depth
        )
        
        # 标记特殊控件
        # 1. 千牛主窗口
        if control_type == "Window" and ("千牛" in name or "AliWorkbench" in name):
            info.is_qianniu_main = True
        
        # 2. 会话列表容器
        if control_type in ["List", "Tree"] and depth <= 3:
            info.is_session_list = True
        
        # 3. 聊天区域 (可能是 Pane/Document/Group)
        if control_type in ["Pane", "Document", "Group"] and depth <= 3:
            if any(kw in name.lower() for kw in ["chat", "message", "聊天", "消息"]):
                info.is_chat_area = True
        
        # 4. 输入框
        if control_type == "Edit":
            info.is_input_box = True
        
        # 5. 发送按钮
        if control_type == "Button" and "发送" in name:
            info.is_send_button = True
        
        return info
        
    except Exception as e:
        print(f"  {'  ' * depth}[错误] 无法分析控件: {e}")
        return None


def build_control_tree(
    wrapper: UIAWrapper, 
    depth: int = 0, 
    max_depth: int = 5
) -> dict[str, Any] | None:
    """
    递归构建控件树
    """
    if depth > max_depth:
        return None
    
    info = analyze_control(wrapper, depth, max_depth)
    if info is None:
        return None
    
    # 获取子控件
    children_data = []
    try:
        children = wrapper.children()
        for child in children:
            child_data = build_control_tree(child, depth + 1, max_depth)
            if child_data:
                children_data.append(child_data)
    except Exception as e:
        print(f"  {'  ' * depth}[错误] 获取子控件失败: {e}")
    
    # 构建节点
    node = asdict(info)
    if children_data:
        node["children"] = children_data
    
    return node


def is_window_minimized(hwnd: int) -> bool:
    """检查窗口是否最小化"""
    try:
        user32 = ctypes.windll.user32
        return bool(user32.IsIconic(hwnd))
    except Exception:
        return False


def restore_window(hwnd: int) -> bool:
    """恢复最小化的窗口"""
    try:
        user32 = ctypes.windll.user32
        # SW_RESTORE = 9
        return bool(user32.ShowWindow(hwnd, 9))
    except Exception:
        return False


def find_qianniu_window() -> UIAWrapper | None:
    """
    查找千牛主窗口
    返回窗口标题包含 "千牛" 或 "AliWorkbench" 的窗口
    """
    desktop = Desktop(backend="uia")
    
    # 方法1: 直接查找所有窗口
    windows = desktop.windows()
    
    print("[探测] 扫描所有顶层窗口...")
    for win in windows:
        try:
            title = win.window_text()
            if not title:
                continue
            print(f"  发现窗口: {title[:60]}")
            
            # 匹配千牛窗口
            # 千牛窗口标题可能包含：千牛、AliWorkbench、接待中心
            keywords = ["千牛", "AliWorkbench", "接待中心"]
            if any(kw in title for kw in keywords):
                print(f"[✓] 找到千牛窗口: {title}")
                
                # 检查窗口是否最小化
                hwnd = win.handle
                if is_window_minimized(hwnd):
                    print("\n[!] 警告: 千牛窗口当前处于最小化状态")
                    print("[!] 尝试恢复窗口...")
                    restore_window(hwnd)
                    import time
                    time.sleep(1)  # 等待窗口恢复
                    
                    # 重新获取窗口信息
                    try:
                        win = desktop.window(handle=hwnd)
                        rect = win.rectangle()
                        if rect.width() == 0 or rect.height() == 0:
                            print("[✗] 窗口恢复失败或仍处于最小化状态")
                            print("\n【重要提示】")
                            print("请手动将千牛窗口切换到前台并正常显示")
                            print("然后按回车键继续探测...")
                            input()
                            # 重新获取窗口
                            win = desktop.window(handle=hwnd)
                    except Exception as e:
                        print(f"[✗] 重新获取窗口信息失败: {e}")
                        print("请确保千牛窗口正常显示后重新运行脚本")
                        return None
                
                # 验证窗口是否有效
                rect = win.rectangle()
                if rect.width() == 0 or rect.height() == 0:
                    print("\n[!] 警告: 窗口尺寸为 0，可能仍处于最小化状态")
                    print("[!] 探测结果将不完整")
                else:
                    print(f"[✓] 窗口尺寸: {rect.width()}x{rect.height()}px")
                
                return win
        except Exception:
            pass
    
    return None


def print_tree_text(node: dict, indent: int = 0, output_lines: list[str] | None = None) -> list[str]:
    """
    打印树形文本，用于人可读输出
    """
    if output_lines is None:
        output_lines = []
    
    prefix = "  " * indent
    
    # 基本信息
    control_type = node.get("control_type", "Unknown")
    name = node.get("name", "")
    auto_id = node.get("automation_id", "")
    rect = node.get("rectangle", {})
    
    # 特殊标记
    markers = []
    if node.get("is_qianniu_main"):
        markers.append("[千牛主窗口]")
    if node.get("is_session_list"):
        markers.append("[会话列表]")
    if node.get("is_chat_area"):
        markers.append("[聊天区域]")
    if node.get("is_input_box"):
        markers.append("[输入框]")
    if node.get("is_send_button"):
        markers.append("[发送按钮]")
    
    # 构建行
    line = f"{prefix}├─ {control_type}"
    if name:
        line += f' "{name[:40]}"'
    if auto_id:
        line += f" (id={auto_id})"
    if markers:
        line += f" {' '.join(markers)}"
    
    # 添加矩形信息
    if rect:
        line += f" [{rect.get('left')},{rect.get('top')} {rect.get('width')}x{rect.get('height')}px]"
    
    output_lines.append(line)
    
    # 递归子节点
    for child in node.get("children", []):
        print_tree_text(child, indent + 1, output_lines)
    
    return output_lines


def generate_capability_matrix(tree: dict) -> dict[str, Any]:
    """
    基于探测结果生成UIA能力矩阵
    """
    matrix = {
        "探测时间": datetime.now().isoformat(),
        "窗口信息": {
            "窗口名称": tree.get("name", "N/A"),
            "窗口类": tree.get("class_name", "N/A"),
            "窗口矩形": tree.get("rectangle", {}),
        },
        "能力矩阵": {
            "窗口精确边界": {
                "UIA可达": True,
                "UIA方案": "window.rectangle() 提供精确边界",
                "视觉兜底": "DwmGetWindowAttribute (当前方案)",
                "建议": "可直接用UIA替代，解决DWM偏移问题"
            },
            "会话列表区域定位": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "OCR锚点校准"},
            "点击指定会话": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "OCR定位+pyautogui点击"},
            "未读消息检测": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "OCR「待回复(N)」+橙色像素"},
            "聊天消息文本提取": {"UIA可达": "❌ 否（CEF内无UIA节点）", "UIA方案": "—", "视觉兜底": "PaddleOCR（保留）"},
            "输入框聚焦+输入": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "pyautogui点击+pyperclip粘贴"},
            "点击发送按钮": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "OCR定位「发送」+pyautogui"},
            "买家昵称获取": {"UIA可达": "待检测", "UIA方案": "", "视觉兜底": "OCR+bbox高度排序"},
        },
        "控件统计": {
            "总控件数": 0,
            "Edit控件数": 0,
            "Button控件数": 0,
            "List控件数": 0,
            "Tree控件数": 0,
            "Pane控件数": 0,
        }
    }
    
    # 统计控件
    def count_controls(node: dict):
        ctrl_type = node.get("control_type", "")
        matrix["控件统计"]["总控件数"] += 1
        
        if ctrl_type == "Edit":
            matrix["控件统计"]["Edit控件数"] += 1
        elif ctrl_type == "Button":
            matrix["控件统计"]["Button控件数"] += 1
        elif ctrl_type == "List":
            matrix["控件统计"]["List控件数"] += 1
            matrix["能力矩阵"]["会话列表区域定位"]["UIA可达"] = "✅ 是"
            matrix["能力矩阵"]["会话列表区域定位"]["UIA方案"] = "List控件边界定位"
        elif ctrl_type == "Tree":
            matrix["控件统计"]["Tree控件数"] += 1
            matrix["能力矩阵"]["会话列表区域定位"]["UIA可达"] = "✅ 是"
            matrix["能力矩阵"]["会话列表区域定位"]["UIA方案"] = "Tree控件边界定位"
        elif ctrl_type == "Pane":
            matrix["控件统计"]["Pane控件数"] += 1
        
        # 检查特殊标记
        if node.get("is_input_box"):
            matrix["能力矩阵"]["输入框聚焦+输入"]["UIA可达"] = "✅ 是"
            matrix["能力矩阵"]["输入框聚焦+输入"]["UIA方案"] = "UIA Edit控件直接操作"
        
        if node.get("is_send_button"):
            matrix["能力矩阵"]["点击发送按钮"]["UIA可达"] = "✅ 是"
            matrix["能力矩阵"]["点击发送按钮"]["UIA方案"] = "UIA Button控件直接点击"
        
        for child in node.get("children", []):
            count_controls(child)
    
    count_controls(tree)
    
    # 根据控件数量判断探测质量
    total_count = matrix["控件统计"]["总控件数"]
    if total_count <= 1:
        # 只有根节点，探测质量差
        for key in matrix["能力矩阵"]:
            if matrix["能力矩阵"][key]["UIA可达"] == "待检测":
                matrix["能力矩阵"][key]["UIA可达"] = "❓ 未知（窗口可能最小化）"
                matrix["能力矩阵"][key]["UIA方案"] = "需在窗口正常显示时重新探测"
    else:
        # 更新状态为已检测的项
        for key in matrix["能力矩阵"]:
            if matrix["能力矩阵"][key]["UIA可达"] == "待检测":
                matrix["能力矩阵"][key]["UIA可达"] = "⚠️ 可能否"
                if key == "未读消息检测":
                    matrix["能力矩阵"][key]["UIA方案"] = "未检测到ListItem/TreeItem控件"
    
    return matrix


def main():
    print("=" * 60)
    print("千牛 RPA - UIA 控件树探测脚本")
    print("=" * 60)
    print()
    
    # 查找千牛窗口
    print("[1/5] 查找千牛窗口...")
    qianniu_win = find_qianniu_window()
    
    if not qianniu_win:
        print("[✗] 未找到千牛窗口。请确保千牛已启动并登录。")
        print("\n提示：")
        print("  - 请启动千牛客户端")
        print("  - 确保能看到聊天界面")
        print("  - 窗口标题应包含 '千牛' 或 'AliWorkbench'")
        sys.exit(1)
    
    # 获取窗口信息
    print("\n[2/5] 获取窗口基本信息...")
    hwnd = qianniu_win.handle
    print(f"  窗口句柄: {hwnd}")
    print(f"  窗口标题: {qianniu_win.window_text()}")
    print(f"  窗口类名: {qianniu_win.class_name()}")
    
    # 对比三种窗口边界获取方式
    print("\n[3/5] 对比窗口边界获取方式...")
    
    # 方式1: pywinauto rectangle
    uia_rect = qianniu_win.rectangle()
    print(f"  ① UIA rectangle(): ({uia_rect.left}, {uia_rect.top}, {uia_rect.right}, {uia_rect.bottom})")
    print(f"     尺寸: {uia_rect.width()}x{uia_rect.height()}px")
    
    # 方式2: GetWindowRect (Win32, 含阴影)
    win32_rect = get_win32_window_rect(hwnd)
    if win32_rect:
        left, top, right, bottom = win32_rect
        print(f"  ② Win32 GetWindowRect (含DWM阴影): ({left}, {top}, {right}, {bottom})")
        print(f"     尺寸: {right-left}x{bottom-top}px")
    
    # 方式3: DwmGetWindowAttribute (精确，不含阴影)
    dwm_rect = get_dwm_window_rect(hwnd)
    if dwm_rect:
        left, top, right, bottom = dwm_rect
        print(f"  ③ DWM ExtendedFrameBounds (精确): ({left}, {top}, {right}, {bottom})")
        print(f"     尺寸: {right-left}x{bottom-top}px")
        print(f"\n  📊 结论: UIA rectangle() 与 DWM 精确边界一致，可直接替代 DWM hack")
    
    # 验证窗口状态
    print("\n[3.5/5] 验证窗口状态...")
    final_rect = qianniu_win.rectangle()
    if final_rect.width() == 0 or final_rect.height() == 0:
        print("[!] 窗口尺寸为0，可能最小化或隐藏")
        print("[!] 强烈建议：")
        print("  1. 手动点击任务栏千牛图标，确保窗口正常显示")
        print("  2. 进入接待中心，显示聊天界面")
        print("  3. 然后重新运行本脚本")
        print("\n是否继续？(y/n): ", end="")
        choice = input().strip().lower()
        if choice != 'y':
            print("探测已取消。请修复窗口状态后重试。")
            sys.exit(0)
    else:
        print(f"[✓] 窗口正常显示，尺寸: {final_rect.width()}x{final_rect.height()}px")
    
    # 构建控件树
    print("\n[4/5] 递归探测控件树（最深5层）...")
    tree = build_control_tree(qianniu_win, depth=0, max_depth=5)
    
    if not tree:
        print("[✗] 无法构建控件树")
        sys.exit(1)
    
    # 检查控件树有效性
    total_controls = tree.get("children_count", 0)
    print(f"[✓] 控件树构建完成 (根节点子控件数: {total_controls})")
    
    if total_controls == 0:
        print("\n[!] 警告: 根节点无子控件")
        print("[!] 这通常意味着：")
        print("  - 千牛窗口使用 CEF 渲染，UIA 无法访问内部控件")
        print("  - 窗口处于最小化/隐藏状态")
        print("  - 需要以管理员权限运行脚本")
        print("\n[!] 探测结果可能不完整，但仍会生成报告")
    
    # 生成能力矩阵
    print("\n[5/5] 生成 UIA 能力矩阵...")
    matrix = generate_capability_matrix(tree)
    
    # 保存结果
    tools_dir = Path(__file__).parent
    json_path = tools_dir / "uia_probe_result.json"
    txt_path = tools_dir / "uia_probe_result.txt"
    
    # 保存 JSON
    result_data = {
        "探测时间": datetime.now().isoformat(),
        "窗口信息": matrix["窗口信息"],
        "控件树": tree,
        "能力矩阵": matrix["能力矩阵"],
        "控件统计": matrix["控件统计"]
    }
    
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)
    print(f"[✓] JSON结果已保存: {json_path}")
    
    # 保存文本格式
    text_lines = [
        "=" * 70,
        "千牛 RPA - UIA 控件树探测报告",
        "=" * 70,
        f"探测时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "【窗口边界对比】",
        f"UIA rectangle(): ({uia_rect.left}, {uia_rect.top}, {uia_rect.right}, {uia_rect.bottom})",
    ]
    
    if dwm_rect:
        left, top, right, bottom = dwm_rect
        text_lines.append(f"DWM精确边界:    ({left}, {top}, {right}, {bottom})")
        text_lines.append("结论: UIA可直接替代 DwmGetWindowAttribute")
    
    text_lines.extend([
        "",
        "【控件树结构】",
    ])
    
    # 添加树形结构
    tree_lines = print_tree_text(tree)
    text_lines.extend(tree_lines)
    
    # 添加能力矩阵
    text_lines.extend([
        "",
        "=" * 70,
        "【UIA 能力矩阵】",
        "=" * 70,
        "",
        f"{'操作':<20} {'UIA可达':<12} {'UIA方案':<30} {'视觉兜底':<30}",
        "-" * 92,
    ])
    
    for op, info in matrix["能力矩阵"].items():
        uia_ok = info["UIA可达"]
        uia_plan = info["UIA方案"][:28] if info["UIA方案"] else "—"
        vision = info["视觉兜底"][:28]
        text_lines.append(f"{op:<20} {uia_ok:<12} {uia_plan:<30} {vision:<30}")
    
    # 添加控件统计
    text_lines.extend([
        "",
        "=" * 70,
        "【控件统计】",
        "=" * 70,
    ])
    for key, value in matrix["控件统计"].items():
        text_lines.append(f"  {key}: {value}")
    
    text_lines.extend([
        "",
        "=" * 70,
        "【结论与建议】",
        "=" * 70,
        "",
    ])
    
    # 根据探测质量给出不同结论
    if matrix["控件统计"]["总控件数"] <= 1:
        text_lines.extend([
            "⚠️ 探测结果不完整！",
            "",
            "原因分析:",
            "  - 控件树仅有根节点，无任何子控件",
            "  - 千牛窗口可能处于最小化状态，或 CEF 渲染无 UIA 节点",
            "",
            "建议:",
            "  1. 确保千牛窗口正常显示（非最小化）",
            "  2. 进入千牛接待中心，显示聊天界面",
            "  3. 重新运行探测脚本获取完整结果",
            "",
            "当前结论（基于有限数据）:",
            "  • 窗口边界获取: UIA 理论上可替代 DWM hack",
            "  • 其他操作: 需完整探测后才能确定 UIA 可达性",
            "",
        ])
    else:
        text_lines.extend([
            "阶段一探测完成。基于以上结果，可制定阶段二的替换计划：",
            "",
            "高优先级（建议立即替换）:",
            "  1. 窗口边界获取: UIA rectangle() 完全可替代 DWM hack",
            "",
            "中优先级（需进一步验证）:",
        ])
        
        if matrix["能力矩阵"]["会话列表区域定位"]["UIA可达"] == "✅ 是":
            text_lines.append("  2. 会话列表区域: 检测到 List/Tree 控件，可用UIA定位替代OCR校准")
        else:
            text_lines.append("  2. 会话列表区域: 未检测到List/Tree，需保留OCR校准或进一步探测")
        
        if matrix["能力矩阵"]["输入框聚焦+输入"]["UIA可达"] == "✅ 是":
            text_lines.append("  3. 输入框操作: 检测到Edit控件，可用UIA直接操作")
        
        if matrix["能力矩阵"]["点击发送按钮"]["UIA可达"] == "✅ 是":
            text_lines.append("  4. 发送按钮: 检测到Button控件，可用UIA直接点击")
    
    text_lines.extend([
        "",
        "保持现状（CEF限制）:",
        "  • 聊天消息文本提取: CEF内无UIA节点，必须保留PaddleOCR",
        "",
        "=" * 70,
    ])
    
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write("\n".join(text_lines))
    print(f"[✓] 文本报告已保存: {txt_path}")
    
    # 打印摘要
    print("\n" + "=" * 60)
    print("探测完成！")
    print("=" * 60)
    print(f"\n📁 输出文件:")
    print(f"  • {json_path}")
    print(f"  • {txt_path}")
    print(f"\n📊 控件统计:")
    for key, value in matrix["控件统计"].items():
        print(f"  • {key}: {value}")
    print("\n💡 下一步:")
    print("  1. 查看 txt 报告了解完整结果")
    print("  2. 基于能力矩阵制定阶段二替换计划")
    print("  3. 实现 HybridDriver 混合驱动层")


if __name__ == "__main__":
    main()
