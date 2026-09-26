# 报价相关验证脚本

这些**不是**一次性排查脚本，而是**回归仪器**：改动报价引擎、定价数据、税率档案、
或产品的显示位数之后，都要跑一遍。

## 怎么跑

```powershell
# 1) 起后端（引擎改动后必须重启，它不热加载）
Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Set-Location backend\orchestrator
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --log-level warning

# 2) 走 HTTP 的那些脚本需要令牌（从环境变量读，不写在文件里）
$env:KAAS_TOKEN = '<开发库的客户令牌>'

# 3) 按需跑
.\.venv\Scripts\python.exe scripts\verify\compare_csv.py
```

## 清单

| 脚本 | 验什么 | 需要令牌 |
|---|---|---|
| `compare_csv.py` | **1392 格金额逐格对照参照表**（`美国 Elhadji Gueye-工厂内部报价表.csv`）—— 「差一分钱就停手」的那道闸门 | 否（在进程内调引擎） |
| `baseline_freeze.py` | 64 组合的金额基线；`--diff` 与冻结基线比对，用于确认改动**没有**动到任何金额 | 否 |
| `verify_pricing_wiring.py` | 定价数据 → 报价 的接线。3 条不变量：改一格只有对应规格变 / 互不串扰 / 改回原值回原价 | 是 |
| `verify_option_extension.py` | 在定价数据里新增档位 → 报价页规格下拉联动 → 撤档位即消失（6 项） | 是 |
| `verify_quote_profiles.py` | 客户税率档案的完整生命周期：存得回、0 与「没填」分得开、错键/百分数被拦、重名被拦、软删（20 项） | 是 |
| `verify_profile_e2e.py` | 档案套用端到端。**关键一项**：同一组规格，套用档案与不套用必须算出**不同金额** —— 否则说明界面没接上，而接口测试看不出来 | 是 |
| `check_decimals.py` | 每列的显示位数是否随报价表下发（金额 2 位、美元 4 位、单价 4 位、丝径 1 位），且与列数等长 | 是 |

## 为什么这些不放 pytest

它们打的是**真实运行的后端 + 开发库**（`verify_profile_e2e.py` 还会往库里写档案再删），
属于 `integration` 语义：需要一个起好的服务与真实数据。
仓库里的 `tests/test_export_quote_profiles_api.py` 覆盖同一批接口约束，
但它标了 `db`、需要有 PostgreSQL 才能跑。

两者是**互补**的，不是重复：

- pytest 用例证明「接口按契约工作」，在任何有测试库的环境都能自动跑；
- 这里的脚本证明「整条链是活的」——尤其 `verify_profile_e2e.py` 的
  「套用后金额必须变」，是接口层查不出来的。

## 注意

- 脚本会往开发库写数据（新增档位 / 保存档案），**跑完自己清理**（每个脚本末尾都有清理段）。
- 令牌是开发库的客户令牌，只用于本地验证；**不要**把它写进文件或提交。
