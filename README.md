# kaas-platform

安平丝网 AI 客服 Demo：消息路由 + 千牛/拼多多 RPA。

## 千牛 Demo 一键启动（Windows）

1. 安装并登录 **千牛**，打开 **接待/客服** 界面。  
2. 双击运行：

```text
scripts\start-demo-qianniu.bat
```

**不要**在 CMD 里手打「保持千牛打开」这类中文再 `&&` 接命令——CMD 会把整段中文当成程序名。正确做法是：只运行上面的 `.bat`，或在 `rpa-qianniu` 目录下执行 **`.venv\Scripts\python.exe`**（注意目录名是 **`.venv` 带点**，不是 `venv`）。

会按需打开 **最多两个** 可见 CMD 窗口：

- **KaaS msg-router :8000**：FastAPI 路由（若本机 `http://127.0.0.1:8000/health` 已可用则跳过）。  
- **KaaS rpa-qianniu**：千牛 RPA（须保持千牛在前台或可见，勿最小化到只剩托盘）。

3. 在 RPA 窗口看到 **「千牛窗口已定位，开始监听」** 后，用 **买家号** 给店铺发一条消息；正常会出现 **`[收到]` → `[AI回复]` → `[已发送]`**。

各子项目说明见 `msg-router/README.md`、`rpa-qianniu/README.md`。
