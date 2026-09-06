# T04 交易 API 实现验收

日期：2026-09-05  
状态：初始阶段验收通过；后续审查修复亦已通过  
环境：WSL Ubuntu / Node.js 22.14.0 / npm 10.9.2

本记录保留 T04 初始验收时的 261 个测试数据。后续补充 31 个回归测试、修复身份竞态、种子开关、415 错误映射及清仓展示，当前全量为 292 个通过；详情见 [T01-T04审查修复验收.md](T01-T04审查修复验收.md)。

## 1. 实现范围

- `POST /api/orders`：从 HttpOnly Cookie 会话取得用户身份，严格接收股票、方向、整数分价格和整数股数，成功返回公开订单和提交后的完整本人快照。
- `GET /api/me/orders`：本人委托历史，支持股票、精确状态、游标和条数筛选。
- `GET /api/me/trades`：本人成交历史，含本人方向及对应本人订单 ID。
- `GET /api/trades`：匿名市场成交历史，不含用户身份和双方订单 ID。
- 三个历史接口默认 50 条、最多 100 条，按服务端序号倒序，游标为独占上界；使用一条额外匹配记录判断是否还有下一页。
- 查询结果包含 serverEpoch；个人结果另含 userId、accountVersion，市场结果另含 marketVersion。
- 交易响应及错误均带请求 ID，私有交易接口设置 `Cache-Control: no-store`。
- 下单校验 Origin、有效会话和 JSON 媒体类型；请求体身份、服务端字段和当前未启用的 clientOrderId 均被拒绝。
- 启动入口默认通过同一撮合服务提交每只股票 1,000 股买卖种子单，买价为初始价减 1 分，卖价为初始价加 1 分；审查修复后支持 ENABLE_DEMO_LIQUIDITY=false 关闭种子挂单。
- 六张种子单在隔离草稿中整批初始化，任一委托失败则真实存储不变；成功标记后重复调用不补单，种子单被吃掉也不补充。
- 原始 `createMemoryStore()` 保持空订单簿，便于独立测试；正式 `index.ts` 在 HTTP 监听前初始化流动性。
- 活跃委托达到上限返回契约规定的 429 / ORDER_LIMIT_REACHED。

本阶段没有实现交易页面、实时行情、WebSocket、幂等重试或撤单。

## 2. 测试先行记录

1. 先创建交易路由、查询分页和种子流动性的测试及 HTTP 夹具。
2. 实现前执行三个目标测试文件：3 个文件失败，71 个用例失败、2 个已有通用 JSON 解析行为通过；种子测试因 `liquidity-seed.ts` 尚不存在而未收集用例。主要失败是交易路径返回 404。
3. 随后实现共享 DTO、交易路由、查询服务、启动种子初始化及应用接线，没有删除或放宽测试断言。
4. 目标测试复验：3 个文件、79 个用例全部通过。
5. 执行 `npm run check`：17 个测试文件、261 个用例全部通过；类型检查、Lint、格式检查、共享包及前后端生产构建全部通过。
6. 另在独立端口 3003 启动生产构建，用两个独立 Cookie 会话运行真实 HTTP 验收脚本；脚本通过后已关闭该验收服务。

新增 79 个测试，加上既有 182 个，共 **261 个通过**：后端 231 个，前端 30 个。

## 3. 自动测试覆盖

| 测试文件 | 用例数 | 主要覆盖 |
| --- | ---: | --- |
| apps/server/src/tests/orders.api.test.ts | 31 | OPEN、FILLED、部分成交响应，双向 maker 价，公开 DTO，余额和冻结，业务错误映射，请求 ID，失败无副作用，自成交，429 容量，并发资金和库存竞争，匿名/伪造/过期/退出会话，Origin、媒体类型、非法及超大 JSON |
| apps/server/src/tests/trading-query.api.test.ts | 42 | 空页元数据、本人委托隔离、股票和状态筛选、OPEN/PARTIALLY_FILLED/FILLED 区分、游标独占和新增记录稳定性、默认/最大条数、更早历史、个人方向、市场脱敏、筛选分页、读取无副作用、查询参数边界 |
| apps/server/src/tests/liquidity-seed.test.ts | 6 | 六张真实挂单、精确冻结、无启动成交、原始空簿、重复初始化、消耗后不补充、整批失败回滚、非空市场拒绝、重启独立状态 |

## 4. 生产 HTTP 验收结果

运行：

```bash
PORT=3003 NODE_ENV=production npm start
node scripts/verify-trading.mjs http://127.0.0.1:3003
```

脚本自动注册两个唯一用户并建立两个 Cookie 会话。启动市场版本为 6，对应六张种子挂单，SIM001 最优买价 999 分、最优卖价 1,001 分。

| 操作 | 验收结果 |
| --- | --- |
| A 买入 100 股 × 1,001 分 | 与系统卖单成交；总现金 99,899,900 分，持仓 100 股 |
| B 买入 50 股 × 1,001 分 | 与系统卖单成交；总现金 99,949,950 分，持仓 50 股 |
| A 卖出 100 股 × 1,000 分 | 不与 999 分系统买单成交；冻结 100 股 |
| B 买入 40 股 × 1,000 分 | 按 A 的 maker 价成交；A 卖单部分成交，剩余 60 股 |
| 最终 A | 总现金 99,939,900 分；持仓 60 股且全部冻结 |
| 最终 B | 总现金 99,909,950 分；持仓 90 股，无冻结 |
| A 再卖 1 股 | 409 INSUFFICIENT_POSITION；双方快照不变 |
| B 提交超资金买单 | 409 INSUFFICIENT_FUNDS；双方快照不变 |
| 历史查询 | 个人方向正确；市场成交按 2 条分页且无身份和订单 ID |
| 会话隔离 | 未登录市场查询 401；伪造 userId 400；A 退出后不能下单，B 仍可查询 |
| 静态入口 | 生产服务 `/login` 返回前端 HTML |

生产脚本报告 3 笔真实成交，并精确得到 A 99,939,900 分现金、60 股冻结持仓，以及 B 99,909,950 分现金、90 股持仓。

## 5. 接口示例

下单请求：

```http
POST /api/orders
Content-Type: application/json
Origin: http://localhost:5173
Cookie: stock_session=...
```

```json
{ "symbol": "SIM001", "side": "BUY", "priceCents": 1001, "quantity": 100 }
```

响应结构：

```json
{
  "data": {
    "order": { "id": "...", "status": "FILLED", "filledQuantity": 100 },
    "snapshot": {
      "serverEpoch": "...",
      "userId": "...",
      "accountVersion": 1,
      "account": {},
      "positions": [],
      "activeOrders": [],
      "recentClosedOrders": [],
      "recentTrades": []
    }
  }
}
```

分页示例：

```text
GET /api/me/orders?status=PARTIALLY_FILLED&symbol=SIM001&limit=50
GET /api/me/trades?symbol=SIM001&limit=50&cursor=123
GET /api/trades?limit=50&cursor=123
```

cursor 表示只返回序号严格小于该值的记录。nextCursor 为本页最后一条的序号；没有更旧的匹配记录时为 null。未知字段、重复参数、0、负数、小数、科学计数法、十六进制和超过安全整数的值均返回 400。

## 6. 后续边界

T05 接入页面时，下单响应的 snapshot 必须校验 serverEpoch、userId 和 accountVersion，不能直接覆盖更新的状态。当前身份加载已检查 serverEpoch 和 userId；accountVersion 的快照比较与统一应用入口需在 T05 接入交易状态时补齐。页面应禁用重复提交，但在 T07 幂等实现前不得自动重试；当前 clientOrderId 会返回 400。

T06 实时链路需要发送完整市场和账户快照。提交服务返回内部 affectedUserIds 供服务端定向推送，但不能发给浏览器。种子账户不可登录，公开行情只显示最佳价格，公开成交不显示其身份。

题目原文保持不变，SHA256：

`7B9BD1C6D4101F2EACD75C95B624E0D2D25D0C16A2087B25D223B16B209C050B`
