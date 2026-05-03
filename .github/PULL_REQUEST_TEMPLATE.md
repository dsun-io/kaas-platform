## 变更范围
<!-- 简述改了什么 -->

## 关联设计章节
<!-- 如：§5.4.1 报价 API / §10.3 TanStack Query -->

## §10 自检清单
- [ ] 10.1 调用链铁律：未直连 PG / FastGPT / LLM
- [ ] 10.2 类型契约：无手写后端类型，zod parse 覆盖
- [ ] 10.3 数据获取：TanStack Query，无 useEffect+fetch
- [ ] 10.4 报价语义：estimated 有警告标签
- [ ] 10.5 错误处理：无 catch(e){}，toast + 错误边界
- [ ] 10.6 鉴权多租户：tenant 从 session 读，无硬编码
- [ ] 10.7 性能可观测：RSC 优先，大表格虚拟滚动
- [ ] 10.8 代码风格：strict TS，conventional commits
- [ ] 10.9 测试：关键路径有 E2E / 单元测试
- [ ] 10.10 部署：环境变量无泄露
