# 千牛RPA 部署指南

## 系统要求

- **操作系统**: Windows 10/11 (64位)
- **Python**: 3.10+
- **内存**: 8GB+ (推荐16GB)
- **显示器**: 1920x1080+ (窗口缩放100%)

## 安装步骤

### 1. 克隆仓库

```powershell
git clone https://github.com/davidsun0124/kaas-platform.git
cd kaas-platform/rpa-qianniu
```

### 2. 创建虚拟环境

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
```

### 3. 安装依赖

```powershell
pip install -r requirements.txt
```

### 4. 安装 PaddleOCR (纯视觉模式必需)

```powershell
pip install paddlepaddle paddleocr
```

### 5. 配置环境变量

```powershell
copy .env.example .env
# 编辑 .env 文件，根据需要修改配置
```

### 6. 启动 msg-router 服务

在另一个终端窗口：

```powershell
cd ../msg-router
python -m app
```

### 7. 运行千牛RPA

```powershell
cd rpa-qianniu
python -m app
```

## 首次运行配置

### 1. 配置 UI 选择器

检查 `config/selectors.json` 是否存在，如果不存在：

```powershell
python -c "from app.ui_selectors import get_selectors; get_selectors()"
```

### 2. 验证窗口定位

```powershell
python scripts/smoke_test.py
```

### 3. 校准视觉区域（纯视觉模式）

```powershell
python scripts/smoke_vision_regions.py --mode calibrate
```

## 性能优化

### 目标：端到端延迟 < 5秒

1. **使用优化配置**:
   ```powershell
   copy .env.latency-optimized .env
   ```

2. **验证延迟**:
   ```powershell
   python scripts/perf_analyzer.py --target-ms 5000
   ```

3. **实时监控**:
   ```powershell
   python scripts/perf_dashboard.py
   ```

## 常见问题

### PaddleOCR 安装失败

- 安装 Visual C++ Redistributable
- 使用 CPU 版本: `pip install paddlepaddle paddleocr`

### 窗口定位失败

- 确保千牛窗口标题包含"千牛"
- 尝试最小化后重新运行
- 检查 `.env` 中的 `QIANNIU_WINDOW_SUBSTRING`

### OCR 识别率低

- 确保显示器缩放为100%
- 调整 `MSG_BANNER_SKIP_PX` 参数
- 运行校准脚本: `smoke_vision_regions.py --mode calibrate`

## 更新部署

```powershell
git pull origin main
pip install -r requirements.txt --upgrade
```

## 生产环境建议

1. **日志轮转**: 定期清理 `logs/` 和 `debug/` 目录
2. **监控告警**: 使用 `perf_dashboard.py` 监控成功率
3. **备份配置**: 备份 `.env` 和 `config/` 目录
4. **自动重启**: 使用进程管理器（如PM2）确保服务持续运行

## 联系支持

如有问题，请提交 Issue 到 GitHub 仓库或联系开发团队。
